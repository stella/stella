import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  createMembershipScopedDb,
  createTenantlessDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { withAggregateTransaction } from "./aggregate-lock";
import {
  AGGREGATE_TRANSACTION_BUDGETS,
  AggregateTransactionTimeoutError,
} from "./aggregate-transaction-budget";
import {
  budgetedSetupRead,
  getTransactionBudget,
  prepareTransactionBudgetSetting,
} from "./transaction-budget-owner";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("aggregate transaction budget (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("aggregate transaction budget (postgres)", () => {
    test.each([
      {
        declared: AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
        requested:
          AGGREGATE_TRANSACTION_BUDGETS.skipLockedBatchPendingMeasurement,
        expected: AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
        setting: "30s",
      },
      {
        declared: AGGREGATE_TRANSACTION_BUDGETS.scopedWorkerPendingMeasurement,
        requested: AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
        expected: AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
        setting: "5s",
      },
    ])(
      "folded admission installs the selected $setting policy in its existing statement",
      async ({ declared, requested, expected, setting }) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const timerStatements: string[] = [];
          const { db } = openClient({
            logger: {
              logQuery: (query) => {
                if (
                  query.includes("set_config('transaction_timeout'") ||
                  query.includes("SET LOCAL transaction_timeout")
                ) {
                  timerStatements.push(query);
                }
              },
            },
          });
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const scoped = createMembershipScopedDb(markRlsDatabase(db), {
            budget: declared,
            organizationId,
            userId,
            serverValidatedWorkspaceIds: [],
            featureAccessSnapshot: buildFeatureAccessSnapshot({
              organizationId,
              userId,
              identity: null,
              enrolments: [],
            }),
          });
          await withAggregateTransaction(
            { transaction: scoped },
            requested,
            async (tx) => {
              expect(getTransactionBudget(tx)).toBe(expected);
              expect(
                await tx.execute(
                  drizzleSql`SELECT current_setting('transaction_timeout') AS timeout`,
                ),
              ).toEqual([{ timeout: setting }]);
            },
          );
          expect(timerStatements).toHaveLength(1);
          expect(timerStatements.at(0)).toContain("set_config('role'");
          expect(timerStatements.at(0)).not.toContain("SET LOCAL");
        });
      },
    );

    test("an empty setup read still installs the timer", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        await openClient().db.transaction(async (tx) => {
          const setting = prepareTransactionBudgetSetting(
            tx,
            AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
          );
          if (setting === undefined) {
            return panic("A capped fixture requires a timer setting");
          }
          expect(
            await tx.execute(
              budgetedSetupRead({
                setting,
                statement: drizzleSql`SELECT 1 WHERE false`,
              }),
            ),
          ).toEqual([]);
          expect(
            await tx.execute(
              drizzleSql`SELECT current_setting('transaction_timeout') AS timeout`,
            ),
          ).toEqual([{ timeout: "30s" }]);
        });
      });
    });

    // timeout: the first setup query itself must be interrupted by the five-second timer.
    test("a folded timer cancels work inside the first setup read", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const failure = await rejectionOf(
          openClient().db.transaction(async (tx) => {
            const setting = prepareTransactionBudgetSetting(
              tx,
              AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
            );
            if (setting === undefined) {
              return panic("A capped fixture requires a timer setting");
            }
            await tx.execute(
              budgetedSetupRead({
                setting,
                statement: drizzleSql`SELECT pg_sleep(6)`,
              }),
            );
          }),
        );
        expect(getPgErrorCode(failure)).toBe("25P04");
      });
    }, 10_000);

    test.each(["membership-scoped", "tenantless"] as const)(
      "a nested %s savepoint inherits the physical transaction deadline",
      async (kind) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const timerStatements: string[] = [];
          const { db } = openClient({
            max: 1,
            logger: {
              logQuery: (query) => {
                if (query.startsWith("SET LOCAL transaction_timeout")) {
                  timerStatements.push(query);
                }
              },
            },
          });
          const outerBudget = AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe;
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          await withAggregateTransaction(db, outerBudget, async (parent) => {
            const marked = markRlsDatabase(parent);
            const nested =
              kind === "tenantless"
                ? createTenantlessDb(
                    marked,
                    AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
                  )
                : createMembershipScopedDb(marked, {
                    budget: AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
                    organizationId,
                    userId,
                    serverValidatedWorkspaceIds: [],
                    featureAccessSnapshot: buildFeatureAccessSnapshot({
                      organizationId,
                      userId,
                      identity: null,
                      enrolments: [],
                    }),
                  });
            await nested(async (savepoint) => {
              expect(savepoint).not.toBe(parent);
              expect(
                await savepoint.execute(drizzleSql`
                SELECT current_setting('transaction_timeout') AS timeout
              `),
              ).toEqual([{ timeout: "5s" }]);
              expect(getTransactionBudget(savepoint)).toBe(outerBudget);
              expect(timerStatements).toEqual([
                "SET LOCAL transaction_timeout = 5000",
              ]);
            });
            expect(
              await parent.execute(drizzleSql`
              SELECT current_setting('transaction_timeout') AS timeout
            `),
            ).toEqual([{ timeout: "5s" }]);
          });
          expect(timerStatements).toEqual([
            "SET LOCAL transaction_timeout = 5000",
          ]);
        });
      },
    );

    // timeout: the five-second database deadline must expire before the assertion.
    test("cancels cumulative short statements and names the budget", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const failure = await rejectionOf(
          withAggregateTransaction(
            openClient({ max: 1 }).db,
            AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
            async (tx) => {
              await tx.execute(
                drizzleSql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
              );
              await tx.execute(
                drizzleSql`SELECT set_config('statement_timeout', '4s', true)`,
              );
              await tx.execute(drizzleSql`SELECT pg_sleep(3)`);
              await tx.execute(drizzleSql`SELECT pg_sleep(3)`);
            },
          ),
        );
        expect(failure).toBeInstanceOf(AggregateTransactionTimeoutError);
        if (!(failure instanceof AggregateTransactionTimeoutError)) {
          throw failure;
        }
        expect(failure.budget).toBe(
          AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
        );
        expect(getPgErrorCode(failure.cause)).toBe("25P04");
      });
    }, 10_000);
  });
}
