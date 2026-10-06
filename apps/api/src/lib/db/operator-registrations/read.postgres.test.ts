import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { asc, eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { systemAuditRuns } from "@/api/db/schema";
import type { TransactionOf } from "@/api/db/scoped";
import { createOperatorRoute } from "@/api/handlers/operator/routes";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";

import { parseRegistrationQuery } from "./input";
import { readAuditedRegistrationPage } from "./read";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const SINCE = "2026-10-04T08:00:00Z";
const NOW = Date.parse("2026-10-05T08:00:00Z");

type AuditReader = Pick<TransactionOf<GatedTestDb>, "select">;

/**
 * Reads operator audits written after this call. A shared DATABASE_URL may
 * already hold operator audits from earlier runs.
 */
const auditsAfterNow = async (tx: AuditReader) => {
  const read = async () =>
    await tx
      .select()
      .from(systemAuditRuns)
      .where(eq(systemAuditRuns.actor, "system:operator-registrations"));
  const before = new Set((await read()).map(({ id }) => id));
  return async () => (await read()).filter(({ id }) => !before.has(id));
};

describe.skipIf(!enabled)("operator registration database pages", () => {
  test("pages equal and submillisecond timestamps without gaps, projects fields, and records one audit per page", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const db = openClient().db;
      // All fixture writes, reads and audit rows roll back together.
      const outcome = await Result.tryPromise({
        try: async () =>
          await db.transaction(async (tx) => {
            const newAudits = await auditsAfterNow(tx);
            const ids = Array.from({ length: 5 }, () =>
              mintAuthProviderIdValue(),
            ).toSorted();
            const orgIds = Array.from({ length: 2 }, () =>
              mintAuthProviderIdValue(),
            );
            for (const [index, id] of ids.entries()) {
              await tx.insert(user).values({
                id,
                name: `Test User ${index}`,
                email: `${id}@example.test`,
                createdAt: sql`${index < 3 ? "2026-10-04T08:00:01.123456Z" : "2026-10-04T08:00:01.123789Z"}::timestamptz`,
                deletedAt: index === 4 ? new Date(NOW) : null,
              });
            }
            for (const [index, id] of orgIds.entries()) {
              await tx.insert(organization).values({
                id,
                name: `Test Organization ${index}`,
                slug: id,
                createdAt: new Date(SINCE),
              });
            }
            const firstUser = ids.at(0);
            const firstOrg = orgIds.at(0);
            const secondOrg = orgIds.at(1);
            if (
              firstUser === undefined ||
              firstOrg === undefined ||
              secondOrg === undefined
            ) {
              throw new TypeError("Fixture IDs required");
            }
            await tx.insert(member).values([
              {
                id: mintAuthProviderIdValue(),
                userId: firstUser,
                organizationId: firstOrg,
                createdAt: new Date(SINCE),
              },
              {
                id: mintAuthProviderIdValue(),
                userId: firstUser,
                organizationId: secondOrg,
                createdAt: new Date(NOW),
              },
            ]);
            // Equal timestamps tie-break on id in the database collation,
            // which can differ from JavaScript's code-unit order.
            const tied = await tx
              .select({ id: user.id })
              .from(user)
              .where(inArray(user.id, ids.slice(0, 3)))
              .orderBy(asc(user.id));
            const expected = [
              ...tied.map(({ id }) => id),
              ...ids.slice(3, 4),
            ].map((id) => `${id}@example.test`);
            const observed: string[] = [];
            let cursor: string | undefined;
            let pageCount = 0;
            do {
              const query = parseRegistrationQuery({
                query: { since: SINCE, limit: "2", cursor },
                now: NOW,
              }).unwrap();
              const page = await readAuditedRegistrationPage(tx, query);
              for (const item of page.items) {
                // Only inspect this fixture; a service-backed database may hold other rows.
                if (!expected.includes(item.email)) {
                  continue;
                }
                expect(Object.keys(item).toSorted()).toEqual([
                  "created_at",
                  "email",
                  "name",
                  "organization",
                ]);
                observed.push(item.email);
                if (item.email === `${firstUser}@example.test`) {
                  expect(item.organization).toEqual({
                    id: firstOrg,
                    name: "Test Organization 0",
                  });
                } else {
                  expect(item.organization).toBeNull();
                }
              }
              pageCount += 1;
              cursor = page.nextCursor ?? undefined;
              expect(pageCount).toBeLessThan(100);
            } while (cursor !== undefined);
            expect(observed).toEqual(expected);
            const fractionalBound = await readAuditedRegistrationPage(tx, {
              since: "2026-10-04T08:00:01.123456001Z",
              limit: 100,
              cursor: null,
            });
            expect(
              fractionalBound.items
                .filter(({ email }) => expected.includes(email))
                .map(({ email }) => email),
            ).toEqual(expected.slice(3));
            const audits = await newAudits();
            expect(audits).toHaveLength(pageCount + 1);
            for (const audit of audits.filter(
              ({ counts }) => counts["pageSize"] === 2,
            )) {
              expect(Object.keys(audit.counts).toSorted()).toEqual([
                "pageSize",
                "returned",
                "sinceEpochMilliseconds",
              ]);
              expect(audit.counts["pageSize"]).toBe(2);
              expect(audit.counts["sinceEpochMilliseconds"]).toBe(
                Date.parse(SINCE),
              );
              expect(JSON.stringify(audit)).not.toContain("@example.test");
            }
            // A successful empty read is still an access event.
            const empty = await readAuditedRegistrationPage(tx, {
              since: "9999-01-01T00:00:00Z",
              limit: 2,
              cursor: null,
            });
            expect(empty.items).toEqual([]);
            expect(await newAudits()).toHaveLength(pageCount + 2);
            tx.rollback();
          }),
        catch: (cause) => cause,
      });
      if (
        Result.isError(outcome) &&
        !(outcome.error instanceof TransactionRollbackError)
      ) {
        throw outcome.error;
      }
      expect(Result.isError(outcome)).toBe(true);
    });
  });

  test.each(["audit-insert", "transaction-completion"])(
    "a %s failure refuses the HTTP response and leaves no audit row",
    async (fault) => {
      if (databaseUrl === undefined) {
        throw new TypeError("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const id = mintAuthProviderIdValue();
        const secret = Bun.randomUUIDv7();
        const outcome = await Result.tryPromise({
          try: async () =>
            await db.transaction(async (tx) => {
              const newAudits = await auditsAfterNow(tx);
              await tx.insert(user).values({
                id,
                name: "Test User",
                email: `${id}@example.test`,
                createdAt: new Date(SINCE),
              });
              const app = createOperatorRoute({
                configuredToken: () => secret,
                now: () => NOW,
                readPage: async (query) =>
                  readAuditedRegistrationPage(
                    {
                      transaction: async (run) =>
                        tx.transaction(async (nested) => {
                          if (fault === "transaction-completion") {
                            await run(nested);
                            return nested.rollback();
                          }
                          return await run({
                            select: nested.select.bind(nested),
                            selectDistinctOn:
                              nested.selectDistinctOn.bind(nested),
                            insert: () => {
                              throw new TypeError(
                                "Audit insertion unavailable",
                              );
                            },
                          });
                        }),
                    },
                    query,
                  ),
              });
              const response = await app.handle(
                new Request(
                  `http://localhost/operator/registrations?since=${SINCE}`,
                  { headers: { authorization: `Bearer ${secret}` } },
                ),
              );
              expect(response.status).toBe(500);
              expect(await response.text()).not.toContain(`${id}@example.test`);
              expect(await newAudits()).toEqual([]);
              tx.rollback();
            }),
          catch: (cause) => cause,
        });
        if (
          Result.isError(outcome) &&
          !(outcome.error instanceof TransactionRollbackError)
        ) {
          throw outcome.error;
        }
        expect(Result.isError(outcome)).toBe(true);
      });
    },
  );
});
