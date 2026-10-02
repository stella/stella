import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { clauses, clauseVersions } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { updateClauseHandler } from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("clause update serialization (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  for (const firstSnapshot of [false, true]) {
    test(`${firstSnapshot ? "snapshot" : "working copy"} commits first; competing precondition conflicts without writes`, async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const first = openClient();
        const second = openClient();
        const observer = openClient().db;
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const clauseId = createSafeId<"clause">();
        const initialBody = [{ text: "Initial body" }];
        const firstBody = [{ text: "First body" }];
        const held = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const probed = Promise.withResolvers<boolean>();
        let firstAudits = 0;
        let secondAudits = 0;
        let operations: Promise<unknown>[] = [];
        try {
          await observer.insert(organization).values({
            id: organizationId,
            name: "Clause fixture",
            slug: organizationId,
            createdAt: new Date(),
          });
          await observer.insert(user).values({
            id: userId,
            name: "Clause fixture",
            email: `${userId}@example.test`,
          });
          await observer.insert(clauses).values({
            id: clauseId,
            organizationId,
            title: "Concurrent clause",
            body: initialBody,
            createdBy: userId,
          });
          const firstBase = toSafeDbMock(
            asTestRaw<ScopedDb>(
              createScopedDb(
                markRlsDatabase(first.db),
                [],
                organizationId,
                userId,
              ),
            ),
          );
          const secondBase = toSafeDbMock(
            asTestRaw<ScopedDb>(
              createScopedDb(
                markRlsDatabase(second.db),
                [],
                organizationId,
                userId,
              ),
            ),
          );
          let firstCalls = 0;
          let secondCalls = 0;
          const firstDb: SafeDb = async (run, retry) => {
            firstCalls += 1;
            const isWrite = firstCalls === 2;
            return await firstBase(async (tx) => {
              const value = await run(tx);
              if (isWrite) {
                held.resolve(undefined);
                await release.promise;
              }
              return value;
            }, retry);
          };
          const secondDb: SafeDb = async (run, retry) => {
            secondCalls += 1;
            const isWrite = secondCalls === 2;
            return await secondBase(async (tx) => {
              if (isWrite) {
                await tx.execute(
                  sql`SELECT set_config('stella_test.clause_id', ${clauseId}, true)`,
                );
                await tx.execute(
                  sql`SELECT set_config('stella_test.blocked', 'false', true)`,
                );
                await tx.execute(sql`DO $probe$
                  BEGIN
                    PERFORM 1 FROM clauses WHERE id = current_setting('stella_test.clause_id')::uuid FOR UPDATE NOWAIT;
                  EXCEPTION WHEN lock_not_available THEN
                    PERFORM set_config('stella_test.blocked', 'true', true);
                  END
                $probe$`);
                const rows = await tx.execute(
                  sql`SELECT current_setting('stella_test.blocked') = 'true' AS blocked`,
                );
                probed.resolve(rows.at(0)?.blocked === true);
              }
              return await run(tx);
            }, retry);
          };
          const firstOperation = Result.gen(() =>
            updateClauseHandler({
              safeDb: firstDb,
              organizationId,
              clauseId,
              body: {
                body: firstBody,
                expectedBody: initialBody,
                snapshotVersion: firstSnapshot,
              },
              recordAuditEvent: async () => {
                firstAudits += 1;
              },
            }),
          );
          operations = [firstOperation];
          await Promise.race([
            held.promise,
            firstOperation.then((result) => {
              throw new Error(
                `First operation finished before its barrier: ${JSON.stringify(result)}`,
              );
            }),
          ]);
          const secondOperation = Result.gen(() =>
            updateClauseHandler({
              safeDb: secondDb,
              organizationId,
              clauseId,
              body: {
                body: [{ text: "Second body" }],
                expectedBody: initialBody,
                snapshotVersion: !firstSnapshot,
              },
              recordAuditEvent: async () => {
                secondAudits += 1;
              },
            }),
          );
          operations.push(secondOperation);
          expect(
            await Promise.race([
              probed.promise,
              secondOperation.then(() => false),
            ]),
          ).toBe(true);
          release.resolve(undefined);
          const [winner, loser] = await Promise.all([
            firstOperation,
            secondOperation,
          ]);
          expect(Result.isOk(winner)).toBe(true);
          expect(Result.isError(loser)).toBe(true);
          if (Result.isError(loser)) {
            expect(loser.error).toMatchObject({ status: 409 });
          }
          const head = await observer.query.clauses.findFirst({
            where: { id: { eq: clauseId } },
          });
          expect(head?.body).toEqual(firstBody);
          expect(head?.currentVersion).toBe(firstSnapshot ? 2 : 1);
          const history = await observer
            .select()
            .from(clauseVersions)
            .where(eq(clauseVersions.clauseId, clauseId));
          expect(history).toHaveLength(firstSnapshot ? 1 : 0);
          if (firstSnapshot) {
            expect(history.at(0)?.body).toEqual(firstBody);
          }
          expect(firstAudits).toBe(1);
          expect(secondAudits).toBe(0);
        } finally {
          release.resolve(undefined);
          const settled = await Promise.allSettled(operations);
          await observer.delete(clauses).where(eq(clauses.id, clauseId));
          await observer
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await observer.delete(user).where(eq(user.id, userId));
          expect(
            settled.filter((result) => result.status === "rejected"),
          ).toEqual([]);
        }
      });
    }, 15_000);
  }
}
