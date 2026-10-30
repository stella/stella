import { expect, test } from "bun:test";
import { sql, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { AGGREGATE_TRANSACTION_BUDGETS } from "@/api/lib/db/aggregate-transaction-budget";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { getTransactionBudget } from "../lib/db/transaction-budget-owner";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
  createSafeDb,
  createScopedDb,
  createTenantlessDb,
  markRlsDatabase,
} from "./scoped";

const fixture = () => {
  const statements: string[] = [];
  const dialect = new PgDialect();
  const database = markRlsDatabase({
    transaction: async <T>(
      run: (tx: {
        execute: (statement: SQLWrapper | string) => Promise<unknown[]>;
      }) => Promise<T>,
    ) =>
      await run({
        execute: async (statement: SQLWrapper | string) => {
          statements.push(
            typeof statement === "string"
              ? statement
              : dialect.sqlToQuery(statement.getSQL()).sql,
          );
          return [];
        },
      }),
  });
  return { database, statements };
};

test.each([
  "scoped",
  "safe",
  "membership-scoped",
  "membership-safe",
  "tenantless",
] as const)(
  "an explicitly selected worker %s scope imposes no transaction deadline",
  async (kind) => {
    const { database, statements } = fixture();
    const budget = AGGREGATE_TRANSACTION_BUDGETS.scopedWorkerPendingMeasurement;
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const membership = {
      budget,
      organizationId,
      userId,
      serverValidatedWorkspaceIds: [],
    };
    const run = (() => {
      switch (kind) {
        case "scoped":
          return createScopedDb(database, {
            budget,
            organizationId,
            userId,
            workspaceScope: [],
          });
        case "safe":
          return createSafeDb(database, {
            budget,
            organizationId,
            userId,
            workspaceIds: [],
          });
        case "membership-scoped":
          return createMembershipScopedDb(database, membership);
        case "membership-safe":
          return createMembershipSafeDb(database, membership);
        case "tenantless":
          return createTenantlessDb(database, budget);
        default:
          return kind satisfies never;
      }
    })();
    let callbackRuns = 0;
    await run(async (tx) => {
      callbackRuns += 1;
      expect(getTransactionBudget(tx)).toBe(budget);
      await tx.execute(sql`SELECT 1`);
    });
    expect(callbackRuns).toBe(1);
    expect(statements.at(-1)).toBe("SELECT 1");
    expect(
      statements.filter((statement) =>
        statement.includes("transaction_timeout"),
      ),
    ).toEqual([]);
  },
);

test.each(["scoped", "tenantless"] as const)(
  "%s request initializes its deadline before its first scoped SQL",
  async (scope) => {
    const { database, statements } = fixture();
    const run =
      scope === "scoped"
        ? createScopedDb(database, {
            budget: AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
            workspaceScope: [],
            organizationId: mintAuthProviderId<"organization">(),
            userId: null,
          })
        : createTenantlessDb(
            database,
            AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
          );
    await run(async (tx) => await tx.execute(sql`SELECT 1`));
    expect(statements.at(0)).toBe(
      `SET LOCAL transaction_timeout = ${AGGREGATE_TRANSACTION_BUDGETS.scopedRequest.milliseconds}`,
    );
    expect(
      statements.filter((statement) =>
        statement.includes("transaction_timeout"),
      ),
    ).toHaveLength(1);
  },
);

test("a worker opens its own untimed transaction even when started inside request work", async () => {
  const request = fixture();
  const worker = fixture();
  const workerBudget =
    AGGREGATE_TRANSACTION_BUDGETS.scopedWorkerPendingMeasurement;
  const scopedWorker = createScopedDb(worker.database, {
    budget: workerBudget,
    workspaceScope: [],
    organizationId: mintAuthProviderId<"organization">(),
    userId: null,
  });
  await withAggregateTransaction(
    request.database,
    AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
    async () => {
      await scopedWorker(async (tx) => {
        expect(getTransactionBudget(tx)).toBe(workerBudget);
        await tx.execute(sql`SELECT 1`);
      });
    },
  );
  expect(request.statements).toEqual([
    `SET LOCAL transaction_timeout = ${AGGREGATE_TRANSACTION_BUDGETS.scopedRequest.milliseconds}`,
  ]);
  expect(
    worker.statements.filter((statement) =>
      statement.includes("transaction_timeout"),
    ),
  ).toEqual([]);
});

test.each([
  AGGREGATE_TRANSACTION_BUDGETS.requestPath,
  AGGREGATE_TRANSACTION_BUDGETS.backgroundBatch,
  AGGREGATE_TRANSACTION_BUDGETS.skipLockedBatchPendingMeasurement,
])(
  "a scoped aggregate keeps its caller's single deadline owner ($kind)",
  async (budget) => {
    const { database, statements } = fixture();
    const scoped = createScopedDb(database, {
      budget: AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
      workspaceScope: [],
      organizationId: mintAuthProviderId<"organization">(),
      userId: null,
    });
    await withAggregateTransaction(
      { transaction: scoped },
      budget,
      async (tx) => await tx.execute(sql`SELECT 1`),
    );
    const timeouts = statements.filter((statement) =>
      statement.includes("transaction_timeout"),
    );
    switch (budget.kind) {
      case "aggregate":
        expect(timeouts).toEqual([
          `SET LOCAL transaction_timeout = ${budget.milliseconds}`,
        ]);
        return;
      case "uncapped-pending-measurement":
        expect(timeouts).toEqual([]);
        return;
      default:
        budget satisfies never;
    }
  },
);
