import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

import {
  ADVISORY_LOCK_MODES,
  AggregateLockBusy,
  AggregateLockUpgradeRefused,
  createAggregateSavepointDatabase,
  withAggregateLock,
  withAggregateSavepoint,
  withAggregateTransaction,
} from "./aggregate-lock";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("shared aggregate advisory locks (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("shared aggregate advisory locks (postgres)", () => {
    test("owned savepoint databases preserve parent ordering and independent rollback", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await db.execute(
          sql`CREATE TEMP TABLE aggregate_savepoint_values (value integer PRIMARY KEY)`,
        );
        const organizationId = mintAuthProviderId<"organization">();
        const earlier = {
          aggregate: "orgFeatureAdmission",
          id: { organizationId, featureId: "flows" },
        } as const;
        const later = {
          aggregate: "definitionCap",
          id: { definitionId: createSafeId<"flowDefinition">() },
        } as const;
        await withAggregateTransaction(db, async (parent) => {
          await parent.execute(
            sql`INSERT INTO aggregate_savepoint_values VALUES (1)`,
          );
          const database = createAggregateSavepointDatabase(parent);
          await withAggregateLock({ ...earlier, tx: parent });
          expect(
            await withAggregateTransaction(database, async (child) => {
              await withAggregateLock({ ...later, tx: child });
              await child.execute(
                sql`INSERT INTO aggregate_savepoint_values VALUES (2)`,
              );
              return "complete";
            }),
          ).toBe("complete");
          expect(
            await rejectionOf(
              withAggregateTransaction(database, async (child) => {
                await child.execute(
                  sql`INSERT INTO aggregate_savepoint_values VALUES (3)`,
                );
                child.rollback();
              }),
            ),
          ).toBeInstanceOf(TransactionRollbackError);
          expect(
            await parent.execute(
              sql`SELECT value FROM aggregate_savepoint_values ORDER BY value`,
            ),
          ).toEqual([{ value: 1 }, { value: 2 }]);
          const nextEarlier = {
            aggregate: "orgFeatureAdmission",
            id: {
              organizationId: mintAuthProviderId<"organization">(),
              featureId: "flows",
            },
          } as const;
          expect(
            await rejectionOf(
              withAggregateTransaction(
                database,
                async (child) =>
                  await withAggregateLock({ ...nextEarlier, tx: child }),
              ),
            ),
          ).toMatchObject({ message: "Aggregate lock rank inversion" });
          expect(
            await rejectionOf(
              withAggregateTransaction(parent, async () => "unused"),
            ),
          ).toMatchObject({
            message:
              "Use the aggregate savepoint owner for nested transactions",
          });
        });
        expect(
          await rejectionOf(
            withAggregateTransaction(db, async (parent) => {
              await parent.execute(
                sql`INSERT INTO aggregate_savepoint_values VALUES (4)`,
              );
              await withAggregateTransaction(
                createAggregateSavepointDatabase(parent),
                async (child) => {
                  await child.execute(
                    sql`INSERT INTO aggregate_savepoint_values VALUES (5)`,
                  );
                },
              );
              parent.rollback();
            }),
          ),
        ).toBeInstanceOf(TransactionRollbackError);
        expect(
          await db.execute(
            sql`SELECT value FROM aggregate_savepoint_values ORDER BY value`,
          ),
        ).toEqual([{ value: 1 }, { value: 2 }]);
      });
    });

    for (const mode of ADVISORY_LOCK_MODES) {
      test(`shared advisory holds ${mode === "shared" ? "coexist with shared" : "block exclusive"} requests across sessions`, async () => {
        const fence = {
          aggregate: "orgFeatureAdmission",
          id: {
            organizationId: mintAuthProviderId<"organization">(),
            featureId: "flows",
          },
        } as const;
        await withInterleaving({
          databaseUrl,
          schedules: [["a.lock", "b.lock", "a.commit", "b.commit"]],
          a: {
            steps: [
              {
                name: "lock",
                run: async (tx) => {
                  expect(
                    await withAggregateLock({ ...fence, tx, mode: "shared" }),
                  ).toEqual({ status: "locked" });
                },
              },
            ],
          },
          b: {
            steps: [
              {
                name: "lock",
                run: async (tx) => {
                  expect(
                    await withAggregateLock({ ...fence, tx, mode }),
                  ).toEqual({ status: "locked" });
                },
              },
            ],
          },
          reset: async () => {},
          readState: async () => undefined,
          invariant: ({ blocked, outcomes }) => {
            expect(blocked).toEqual(mode === "shared" ? [] : ["b.lock"]);
            expect(outcomes).toEqual({
              a: { status: "committed" },
              b: { status: "committed" },
            });
          },
        });
      });
    }

    test("shared NOWAIT reports typed Busy behind an exclusive session and succeeds after release", async () => {
      const fence = {
        aggregate: "orgFeatureAdmission",
        id: {
          organizationId: mintAuthProviderId<"organization">(),
          featureId: "flows",
        },
      } as const;
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const holder = openClient();
        const contender = openClient();
        await holder.db.transaction(async (tx) => {
          await withAggregateLock({ ...fence, tx });
          await contender.db.transaction(async (other) => {
            const result = await withAggregateLock({
              ...fence,
              tx: other,
              mode: "shared",
              wait: "nowait",
            });
            if (result.status !== "busy") {
              panic("Expected shared contention");
            }
            expect(result.error).toBeInstanceOf(AggregateLockBusy);
            expect(
              (await other.execute(sql`SELECT 1 AS healthy`)).at(0),
            ).toEqual({ healthy: 1 });
          });
        });
        await contender.db.transaction(async (tx) => {
          expect(
            await withAggregateLock({
              ...fence,
              tx,
              mode: "shared",
              wait: "nowait",
            }),
          ).toEqual({ status: "locked" });
        });
      });
    });

    test("two shared sessions refuse upgrades while their transactions remain usable", async () => {
      const fence = {
        aggregate: "orgFeatureAdmission",
        id: {
          organizationId: mintAuthProviderId<"organization">(),
          featureId: "flows",
        },
      } as const;
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const a = openClient();
        const b = openClient();
        await a.db.transaction(async (tx) => {
          await withAggregateLock({ ...fence, tx, mode: "shared" });
          await b.db.transaction(async (other) => {
            await withAggregateLock({ ...fence, tx: other, mode: "shared" });
            for (const wait of ["block", "nowait"] as const) {
              await withAggregateSavepoint(tx, async (child) => {
                expect(
                  await rejectionOf(
                    withAggregateLock({
                      ...fence,
                      tx: child,
                      mode: "exclusive",
                      wait,
                    }),
                  ),
                ).toBeInstanceOf(AggregateLockUpgradeRefused);
              });
              expect(
                await rejectionOf(
                  withAggregateLock({
                    ...fence,
                    tx: other,
                    mode: "exclusive",
                    wait,
                  }),
                ),
              ).toBeInstanceOf(AggregateLockUpgradeRefused);
            }
            expect(
              (await other.execute(sql`SELECT 1 AS healthy`)).at(0),
            ).toEqual({ healthy: 1 });
          });
          expect((await tx.execute(sql`SELECT 1 AS healthy`)).at(0)).toEqual({
            healthy: 1,
          });
        });
      });
    });
  });
}
