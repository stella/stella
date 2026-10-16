import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { MATTER_VISIBILITY } from "@stll/api-contract";

import { member, organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createDuplicateWorkspace } from "@/api/handlers/workspaces/duplicate";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { lockMatterStewardship } from "@/api/lib/db/aggregate-lock";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";
import { insertWorkspaceRowsInTransaction } from "@/api/lib/workspaces/create-workspace-row";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("matter duplicate snapshot concurrency", () => {
  test("refuses an outdated public snapshot even when its actor still reaches the narrowed matter", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const organizationId = mintAuthProviderId<"organization">();
      const actorUserId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const requests = [
        { organizationId, workspaceIds: [workspaceId], userIds: [actorUserId] },
      ];
      const events: AuditEvent[] = [];
      const recordAuditEvent: AuditRecorder = (_tx, event) => {
        events.push(...(Array.isArray(event) ? event : [event]));
      };
      const endpoint = createDuplicateWorkspace({
        enqueueDocumentProcessingRun: async () =>
          panic("Refused duplicate must not enqueue processing"),
        enqueueEntitySearchRepairs: async () =>
          panic("Refused duplicate must not enqueue repairs"),
        enqueueWorkspaceSearchRepairs: async () =>
          panic("Refused duplicate must not enqueue repairs"),
        flushEntitySearchRepairs: async () =>
          panic("Refused duplicate must not flush repairs"),
        flushWorkspaceSearchRepairs: async () =>
          panic("Refused duplicate must not flush repairs"),
        requestNativeExtractionRuns: async () =>
          panic("Refused duplicate must not create extraction runs"),
      });
      type DuplicateContext = Parameters<typeof endpoint.handler>[0];
      const tasks: ReturnType<typeof endpoint.handler>[] = [];
      const results: Awaited<ReturnType<typeof endpoint.handler>>[] = [];
      const snapshotReady = Promise.withResolvers<undefined>();
      const resume = Promise.withResolvers<undefined>();
      await db.insert(organization).values({
        id: organizationId,
        name: "Duplicate snapshot",
        slug: `duplicate-snapshot-${suffix}`,
        createdAt: new Date(),
      });
      await db.insert(user).values({
        id: actorUserId,
        name: "Assigned owner",
        email: `${actorUserId}-${suffix}@example.test`,
      });
      await db.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId: actorUserId,
        role: "owner",
        createdAt: new Date(),
      });
      await db.transaction(async (tx) => {
        await insertWorkspaceRowsInTransaction({
          tx,
          rows: [
            {
              id: workspaceId,
              organizationId,
              name: "Source matter",
              reference: suffix,
              leadUserId: actorUserId,
              visibility: MATTER_VISIBILITY.allMembers,
            },
          ],
        });
        await tx
          .insert(workspaceMembers)
          .values({ workspaceId, userId: actorUserId });
      });
      try {
        await withInterleaving({
          databaseUrl,
          schedules: [
            ["b.snapshot", "a.narrow", "a.commit", "b.duplicate", "b.commit"],
          ],
          a: {
            steps: [
              {
                name: "narrow",
                run: async (tx) => {
                  await lockMatterStewardship({ tx, requests, mode: "update" });
                  await tx
                    .update(workspaces)
                    .set({ visibility: MATTER_VISIBILITY.assignedOnly })
                    .where(eq(workspaces.id, workspaceId));
                },
              },
            ],
          },
          b: {
            steps: [
              {
                name: "snapshot",
                run: async (tx, signal) => {
                  signal.addEventListener(
                    "abort",
                    () => resume.resolve(undefined),
                    { once: true },
                  );
                  let calls = 0;
                  const safeDb = safeDbFromScoped(async (run) => {
                    const value = await run(tx);
                    calls += 1;
                    if (calls === 1) {
                      // The real snapshot is complete; its transaction deliberately
                      // holds no source lock while another writer narrows the matter.
                      snapshotReady.resolve(undefined);
                      await resume.promise;
                    }
                    return value;
                  });
                  const context = createTestHandlerContext<DuplicateContext>({
                    safeDb,
                    scopedDb: NO_DB,
                    workspaceId,
                    session: { activeOrganizationId: organizationId },
                    user: { id: actorUserId },
                    audit: recordAuditEvent,
                    body: { includeContent: false },
                    featureAccessSnapshot: createFeatureAccessSnapshot({
                      organizationId,
                      userId: actorUserId,
                      decisions: new Map([
                        [
                          "list-verification",
                          decideFeatureAccess({
                            registry: {
                              "list-verification": { enrolment: "invitation" },
                            },
                            featureId: "list-verification",
                            organizationId,
                            userId: actorUserId,
                            user: {
                              email: "owner@example.test",
                              emailVerified: true,
                            },
                            membership: true,
                            grants: {},
                          }),
                        ],
                      ]),
                    }),
                  });
                  const task = endpoint.handler(context);
                  tasks.push(task);
                  await Promise.race([
                    snapshotReady.promise,
                    task.then(() =>
                      panic("Duplicate finished before its snapshot barrier"),
                    ),
                  ]);
                },
              },
              {
                name: "duplicate",
                run: async (tx) => {
                  const matter = (
                    await tx
                      .select({
                        visibility: workspaces.visibility,
                        reaches: memberReachesMatterSql(
                          { organizationId, userId: actorUserId },
                          workspaces.id,
                        ),
                      })
                      .from(workspaces)
                      .where(eq(workspaces.id, workspaceId))
                  ).at(0);
                  expect(matter).toEqual({
                    visibility: MATTER_VISIBILITY.assignedOnly,
                    reaches: true,
                  });
                  resume.resolve(undefined);
                  results.push(
                    await (tasks.at(0) ?? panic("Duplicate task missing")),
                  );
                },
              },
            ],
          },
          reset: async () => {
            expect(
              (
                await db
                  .select({ visibility: workspaces.visibility })
                  .from(workspaces)
                  .where(eq(workspaces.id, workspaceId))
              ).at(0)?.visibility,
            ).toBe(MATTER_VISIBILITY.allMembers);
          },
          readState: async () =>
            await db
              .select({ id: workspaces.id, visibility: workspaces.visibility })
              .from(workspaces)
              .where(eq(workspaces.organizationId, organizationId))
              .limit(2),
          invariant: ({ outcomes, state }) => {
            expect(outcomes.a.status).not.toBe("deadlock");
            expect(outcomes.b.status).not.toBe("deadlock");
            expect(outcomes).toEqual({
              a: { status: "committed" },
              b: { status: "committed" },
            });
            expect(results).toHaveLength(1);
            expect(results.at(0)).toMatchObject({
              code: 409,
              response: { message: "Source matter changed; retry duplication" },
            });
            expect(events).toEqual([]);
            expect(state).toEqual([
              { id: workspaceId, visibility: MATTER_VISIBILITY.assignedOnly },
            ]);
          },
        });
      } finally {
        resume.resolve(undefined);
        await Promise.allSettled(tasks);
        await db.transaction(async (tx) => {
          await lockMatterStewardship({ tx, requests, mode: "update" });
          await tx
            .delete(organization)
            .where(eq(organization.id, organizationId));
        });
        await db.delete(user).where(eq(user.id, actorUserId));
      }
    });
  });
});
