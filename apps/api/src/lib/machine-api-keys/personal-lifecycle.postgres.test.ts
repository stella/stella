import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, getTableName, inArray, sql } from "drizzle-orm";

import { apikey, member, organization, user } from "@/api/db/auth-schema";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { escapeLike } from "@/api/lib/escape-like";
import {
  createPersonalApiKey,
  listPersonalApiKeys,
} from "@/api/lib/machine-api-keys/personal-lifecycle";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

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
        try {
          const create = async (database: typeof firstDb) =>
            await createPersonalApiKey({
              name: "Parallel key",
              organizationId,
              userId,
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
    }, 15_000);
  });
}
