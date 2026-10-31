import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  organizationDataExports,
  requestIdempotencyReceipts,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import createDataExport from "@/api/handlers/data-exports/create";
import downloadDataExport from "@/api/handlers/data-exports/download";
import { createSafeId } from "@/api/lib/branded-types";
import { fingerprintHttpRequest } from "@/api/lib/idempotency/request-receipts";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("organization export replay (postgres)", () => {
  test.each(["create", "download"] as const)(
    "%s rechecks permission before replay and before any new write",
    async (operation) => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const { db } = openClient();
          const fixture = await flowReviewGateFixture(db, {
            intermediate: false,
          });
          const userId = mintAuthProviderId<"user">();
          const { organizationId } = fixture;
          await db.insert(user).values({
            id: userId,
            name: "Export requester",
            email: `${userId}@example.test`,
          });
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "admin",
            createdAt: new Date(),
          });
          const scopedDb = createScopedDb(
            markRlsDatabase(db),
            [],
            organizationId,
            userId,
          );
          const key = Bun.randomUUIDv7();
          const request = (idempotencyKey: string) =>
            new Request("https://example.test/export", {
              method: "POST",
              headers: { "Idempotency-Key": idempotencyKey },
            });
          const losePermission = async () =>
            await db
              .update(member)
              .set({ role: "member" })
              .where(
                and(
                  eq(member.organizationId, organizationId),
                  eq(member.userId, userId),
                ),
              );
          const receiptCount = async () =>
            await db.$count(
              requestIdempotencyReceipts,
              eq(requestIdempotencyReceipts.organizationId, organizationId),
            );
          const common = {
            audit: fixture.recordAuditEvent,
            scopedDb,
            safeDb: safeDbFromScoped(scopedDb),
            memberRole: sessionMemberRole("admin"),
            session: { activeOrganizationId: organizationId },
            user: { id: userId },
            set: { status: 200, headers: {} },
          };
          try {
            switch (operation) {
              case "create": {
                const context = createTestHandlerContext<
                  Parameters<typeof createDataExport.handler>[0]
                >({
                  ...common,
                  route: "/v1/data-exports",
                  request: request(key),
                  body: { versions: "all" },
                  params: {},
                  query: {},
                });
                const first = await createDataExport.handler(context);
                expect(first).toMatchObject({
                  outcome: "started",
                  export: { status: "queued" },
                });
                const replay = await createDataExport.handler(context);
                expect(replay).toBeInstanceOf(Response);
                if (!(replay instanceof Response)) {
                  panic("Expected create replay response");
                }
                expect(await replay.json()).toEqual(first);
                expect(
                  await db.$count(
                    organizationDataExports,
                    eq(organizationDataExports.organizationId, organizationId),
                  ),
                ).toBe(1);
                expect(
                  await db.$count(
                    organizationDataExports,
                    and(
                      eq(
                        organizationDataExports.organizationId,
                        organizationId,
                      ),
                      eq(organizationDataExports.status, "queued"),
                    ),
                  ),
                ).toBe(1);
                expect(await receiptCount()).toBe(1);
                await losePermission();
                expect(await createDataExport.handler(context)).toMatchObject({
                  code: 403,
                });
                expect(
                  await createDataExport.handler({
                    ...context,
                    request: request(Bun.randomUUIDv7()),
                  }),
                ).toMatchObject({ code: 403 });
                expect(await receiptCount()).toBe(1);
                expect(
                  await db.$count(
                    organizationDataExports,
                    eq(organizationDataExports.organizationId, organizationId),
                  ),
                ).toBe(1);
                break;
              }
              case "download": {
                const exportId = createSafeId<"dataExport">();
                const route = "/v1/data-exports/:exportId/download";
                const body = { file: { type: "manifest" } } as const;
                const params = { exportId };
                const responseBody = {
                  url: "https://example.test/export-part",
                  urlExpiresAt: "2099-01-01T00:00:00.000Z",
                };
                const fingerprint = await fingerprintHttpRequest({
                  method: "POST",
                  route,
                  body,
                  params,
                  query: {},
                });
                await scopedDb(
                  async (tx) =>
                    await tx.insert(requestIdempotencyReceipts).values({
                      organizationId,
                      userId,
                      idempotencyKey: key,
                      route,
                      requestFingerprint: fingerprint,
                      state: "completed",
                      responseCode: 200,
                      responseBody,
                      completedAt: new Date(),
                    }),
                );
                const context = createTestHandlerContext<
                  Parameters<typeof downloadDataExport.handler>[0]
                >({
                  ...common,
                  route,
                  request: request(key),
                  body,
                  params,
                  query: {},
                });
                const replay = await downloadDataExport.handler(context);
                expect(replay).toBeInstanceOf(Response);
                if (!(replay instanceof Response)) {
                  panic("Expected download replay response");
                }
                expect(await replay.json()).toEqual(responseBody);
                await losePermission();
                expect(await downloadDataExport.handler(context)).toMatchObject(
                  { code: 403 },
                );
                expect(
                  await downloadDataExport.handler({
                    ...context,
                    request: request(Bun.randomUUIDv7()),
                  }),
                ).toMatchObject({ code: 403 });
                expect(await receiptCount()).toBe(1);
                break;
              }
              default:
                operation satisfies never;
                panic("Unknown export replay operation");
            }
          } finally {
            await fixture.cleanup();
            await db.delete(user).where(eq(user.id, userId));
          }
        },
      );
    },
  );
});
