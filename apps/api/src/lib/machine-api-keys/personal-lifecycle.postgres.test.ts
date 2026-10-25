import { panic } from "better-result";
import type { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, getTableName, inArray, sql } from "drizzle-orm";

import {
  apikey,
  member,
  organization,
  session,
  user,
} from "@/api/db/auth-schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { revokeAllUserDurableCredentials } from "@/api/lib/auth-artifacts";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import {
  createPersonalApiKey,
  issueMachineApiKey,
  listPersonalApiKeys,
} from "@/api/lib/machine-api-keys/personal-lifecycle";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

const liveSessionRow = (userId: string) => ({
  id: `session-${userId}`,
  token: `token-${userId}`,
  userId,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  updatedAt: new Date(),
});

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("personal key concurrency (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  describe("personal key concurrency (postgres)", () => {
    test("parallel mints cannot exceed five active keys for the same member", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient();
        const { db: secondDb } = openClient();
        const { db: controlDb } = openClient();
        const { db: observerDb } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const recordAuditEvent = createBackgroundAuditRecorder({
          organizationId,
          userId,
          workspaceId: null,
          execution: {
            performer: { type: "user", id: userId },
            trigger: {
              type: "system",
              source: "personal_key_concurrency_test",
            },
          },
        });
        await firstDb.insert(user).values({
          id: userId,
          name: "Fixture member",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await firstDb.insert(organization).values({
          id: organizationId,
          name: "Key concurrency fixture",
          slug: organizationId,
          createdAt: new Date(),
        });
        await firstDb.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        });
        const liveSession = liveSessionRow(userId);
        await firstDb.insert(session).values(liveSession);
        const sessionId = liveSession.id;
        try {
          const create = async (database: typeof firstDb) =>
            await createPersonalApiKey({
              name: "Parallel key",
              organizationId,
              userId,
              sessionId,
              recordAuditEvent,
              database,
            });
          const seeded = [];
          for (let index = 0; index < 4; index += 1) {
            const result = await create(firstDb);
            if (result.isErr()) {
              panic(result.error.message);
            }
            seeded.push(result.value);
          }
          const [firstWorker] = await firstDb
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(organization)
            .where(eq(organization.id, organizationId));
          const [secondWorker] = await secondDb
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(organization)
            .where(eq(organization.id, organizationId));
          if (!firstWorker || !secondWorker) {
            panic("Both mint sessions must exist");
          }
          expect(firstWorker.pid).not.toBe(secondWorker.pid);
          const pending: ReturnType<typeof create>[] = [];
          // Both named worker sessions must wait at the organization reservation
          // SELECT before the control transaction releases its row lock.
          try {
            await controlDb.transaction(async (tx) => {
              const [locked] = await tx
                .select({ id: organization.id })
                .from(organization)
                .where(eq(organization.id, organizationId))
                .for("update");
              if (!locked) {
                panic("Fixture organization must exist");
              }
              pending.push(create(firstDb), create(secondDb));
              const deadline = performance.now() + 5000;
              while (performance.now() < deadline) {
                const [snapshot] = await observerDb
                  .select({
                    waiting: sql<number>`(SELECT count(*)::integer FROM pg_stat_activity
                    WHERE pid IN (${firstWorker.pid}, ${secondWorker.pid})
                      AND wait_event_type = 'Lock'
                      AND query ILIKE ${`% from "${escapeLike(getTableName(organization))}" where % for no key update`})`,
                  })
                  .from(organization)
                  .where(eq(organization.id, organizationId));
                if (snapshot?.waiting === 2) {
                  return;
                }
                await Bun.sleep(10);
              }
              panic(
                "Both competing mints must wait at the organization reservation SELECT",
              );
            });
          } finally {
            // The control transaction has released the lock even on failure.
            // Drain writers before fixture cleanup can delete their rows.
            await Promise.all(pending);
          }
          const results = await Promise.all(pending);
          expect(results.filter((result) => result.isOk())).toHaveLength(1);
          expect(results.filter((result) => result.isErr())).toHaveLength(1);
          for (const result of results) {
            if (result.isErr()) {
              expect(result.error.status).toBe(409);
            }
          }
          const page = await listPersonalApiKeys(
            { organizationId, userId, access: "own", limit: 20 },
            firstDb,
          );
          expect(page.items.filter((key) => key.enabled)).toHaveLength(5);
          const ids = [
            ...seeded.map((key) => key.id),
            ...results.flatMap((result) =>
              result.isOk() ? [result.value.id] : [],
            ),
          ];
          if (ids.length !== 5) {
            panic("All successful mints must have persisted ids");
          }
          expect(
            await firstDb.select().from(apikey).where(inArray(apikey.id, ids)),
          ).toHaveLength(5);
        } finally {
          await firstDb.delete(apikey).where(eq(apikey.referenceId, userId));
          await firstDb
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await firstDb.delete(user).where(eq(user.id, userId));
        }
      });
    }, 15_000); // timeout: three pooled clients connect and seed before the lock barrier

    type RacingMint = {
      organizationId: SafeId<"organization">;
      userId: SafeId<"user">;
      sessionId: string;
      database: Parameters<typeof createPersonalApiKey>[0]["database"];
    };
    const racingAuditRecorder = ({ organizationId, userId }: RacingMint) =>
      createBackgroundAuditRecorder({
        organizationId,
        userId,
        workspaceId: null,
        execution: {
          performer: { type: "user", id: userId },
          trigger: {
            type: "system",
            source: "personal_key_concurrency_test",
          },
        },
      });
    // Every session-authorized issuer takes the same fence.
    const ISSUERS = {
      "personal key": async (options: RacingMint) =>
        await createPersonalApiKey({
          ...options,
          name: "Racing key",
          recordAuditEvent: racingAuditRecorder(options),
        }),
      "machine key": async (options: RacingMint) =>
        await issueMachineApiKey({
          ...options,
          name: "Racing key",
          scopes: ["stella:read"],
          permissions: { workspace: ["read"] },
          expiresInDays: undefined,
          audience: undefined,
          recordAuditEvent: racingAuditRecorder(options),
          auditEvent: (key) => ({
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
            resourceId: key.id,
            metadata: { name: key.name, scopes: key.scopes },
          }),
        }),
    } satisfies Record<
      string,
      (options: RacingMint) => Promise<Result<unknown, HandlerError>>
    >;

    test.each(Object.entries(ISSUERS))(
      "a %s mint racing an access reset either is revoked by it or finds its session ended",
      async (_name, issue) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db: mintDb } = openClient();
          const { db: resetDb } = openClient();
          const { sql: observer } = openClient();
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          await mintDb.insert(user).values({
            id: userId,
            name: "Fixture member",
            email: `${userId}@example.test`,
            emailVerified: true,
          });
          await mintDb.insert(organization).values({
            id: organizationId,
            name: "Key reset fixture",
            slug: organizationId,
            createdAt: new Date(),
          });
          await mintDb.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "member",
            createdAt: new Date(),
          });
          const liveSession = liveSessionRow(userId);
          await mintDb.insert(session).values(liveSession);
          const sessionId = liveSession.id;
          const [mintWorker] = await mintDb
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(organization)
            .where(eq(organization.id, organizationId));
          if (!mintWorker) {
            panic("The mint session must exist");
          }
          try {
            let pending: ReturnType<typeof issue> | undefined;
            // The reset holds the credential fence while the mint arrives; the
            // mint must wait for it and then see the session the reset ended.
            await resetDb.transaction(async (tx) => {
              const [resetWorker] = await tx
                .select({ pid: sql<number>`pg_backend_pid()` })
                .from(organization)
                .where(eq(organization.id, organizationId));
              if (!resetWorker) {
                panic("The reset session must exist");
              }
              await revokeAllUserDurableCredentials(tx, userId);
              pending = issue({
                organizationId,
                userId,
                sessionId,
                database: mintDb,
              });
              await waitForBlockedPid(observer, {
                waitingPid: mintWorker.pid,
                holdingPid: resetWorker.pid,
              });
            });
            if (pending === undefined) {
              panic("The racing mint must have started");
            }
            const minted = await pending;
            expect(minted.isErr()).toBe(true);
            if (minted.isErr()) {
              expect(minted.error.status).toBe(401);
            }
            expect(
              await mintDb
                .select({ id: apikey.id })
                .from(apikey)
                .where(eq(apikey.referenceId, userId)),
            ).toEqual([]);
          } finally {
            await mintDb.delete(apikey).where(eq(apikey.referenceId, userId));
            await mintDb
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await mintDb.delete(user).where(eq(user.id, userId));
          }
        });
      },
      15_000,
    );
  });
}
