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
import { getTransactionBudget } from "./transaction-budget-owner";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("aggregate transaction budget (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("aggregate transaction budget (postgres)", () => {
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
