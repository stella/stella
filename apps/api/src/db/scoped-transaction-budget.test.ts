import { expect, test } from "bun:test";
import { sql, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  AGGREGATE_TRANSACTION_BUDGETS,
  AggregateTransactionTimeoutError,
} from "@/api/lib/db/aggregate-transaction-budget";
import { PG_ERROR } from "@/api/lib/pg-error";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import {
  getTransactionBudget,
  withTransactionBudgetContext,
} from "../lib/db/transaction-budget-owner";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
  createSafeDb,
  createScopedDb,
  createTenantlessDb,
  markRlsDatabase,
} from "./scoped";
import type { TransactionOf } from "./scoped";

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

test.each(["scoped", "tenantless"] as const)(
  "%s scopes retain the tighter explicit or pending deadline",
  async (scope) => {
    for (const { declared, requested, expected } of [
      {
        declared: AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
        requested:
          AGGREGATE_TRANSACTION_BUDGETS.skipLockedBatchPendingMeasurement,
        expected: AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
      },
      {
        declared: AGGREGATE_TRANSACTION_BUDGETS.scopedWorkerPendingMeasurement,
        requested: AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
        expected: AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
      },
    ]) {
      const { database, statements } = fixture();
      const run =
        scope === "scoped"
          ? createScopedDb(database, {
              budget: declared,
              workspaceScope: [],
              organizationId: mintAuthProviderId<"organization">(),
              userId: null,
            })
          : createTenantlessDb(database, declared);
      await withTransactionBudgetContext(
        requested,
        async () =>
          await run(async (tx) => {
            expect(getTransactionBudget(tx)).toBe(expected);
            await tx.execute(sql`SELECT 1`);
          }),
      );
      expect(
        statements.filter((statement) =>
          statement.includes("transaction_timeout"),
        ),
      ).toEqual([`SET LOCAL transaction_timeout = ${expected.milliseconds}`]);
    }
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

test("a scoped commit timeout identifies the physical request budget under an uncapped caller", async () => {
  const { database, statements } = fixture();
  const cause = { cause: { code: PG_ERROR.TRANSACTION_TIMEOUT } };
  const rejectCommitDatabase = markRlsDatabase({
    transaction: async <T>(
      run: (tx: TransactionOf<typeof database>) => Promise<T>,
    ): Promise<T> => {
      await database.transaction(run);
      return await Promise.reject(cause);
    },
  });
  const budget = AGGREGATE_TRANSACTION_BUDGETS.scopedRequest;
  const scoped = createScopedDb(rejectCommitDatabase, {
    budget,
    workspaceScope: [],
    organizationId: mintAuthProviderId<"organization">(),
    userId: null,
  });
  const failure = await rejectionOf(
    withAggregateTransaction(
      { transaction: scoped },
      AGGREGATE_TRANSACTION_BUDGETS.skipLockedBatchPendingMeasurement,
      async (tx) => {
        expect(getTransactionBudget(tx)).toBe(budget);
        await tx.execute(sql`SELECT 1`);
      },
    ),
  );
  expect(failure).toBeInstanceOf(AggregateTransactionTimeoutError);
  if (!AggregateTransactionTimeoutError.is(failure)) {
    return;
  }
  expect(failure.budget).toBe(budget);
  expect(failure.cause).toBe(cause);
  expect(failure.message).toContain(`${budget.milliseconds} ms`);
  expect(
    statements.filter((statement) => statement.includes("transaction_timeout")),
  ).toEqual([`SET LOCAL transaction_timeout = ${budget.milliseconds}`]);
});

test("a tenant setup timeout identifies the request budget before the aggregate callback runs", async () => {
  const budget = AGGREGATE_TRANSACTION_BUDGETS.scopedRequest;
  const cause = { cause: { code: PG_ERROR.TRANSACTION_TIMEOUT } };
  const statements: string[] = [];
  const dialect = new PgDialect();
  const tx = {
    execute: async (statement: SQLWrapper | string) => {
      const text =
        typeof statement === "string"
          ? statement
          : dialect.sqlToQuery(statement.getSQL()).sql;
      statements.push(text);
      if (statements.length === 1) {
        expect(text).toBe(
          `SET LOCAL transaction_timeout = ${budget.milliseconds}`,
        );
        return [];
      }
      expect(text).toContain("set_config(");
      return await Promise.reject(cause);
    },
  };
  const database = markRlsDatabase({
    transaction: async <T>(run: (transaction: typeof tx) => Promise<T>) =>
      await run(tx),
  });
  const scoped = createScopedDb(database, {
    budget,
    workspaceScope: [],
    organizationId: mintAuthProviderId<"organization">(),
    userId: null,
  });
  let callbackRuns = 0;
  const failure = await rejectionOf(
    withAggregateTransaction(
      { transaction: scoped },
      AGGREGATE_TRANSACTION_BUDGETS.skipLockedBatchPendingMeasurement,
      async () => {
        callbackRuns += 1;
      },
    ),
  );
  expect(callbackRuns).toBe(0);
  expect(failure).toBeInstanceOf(AggregateTransactionTimeoutError);
  if (!AggregateTransactionTimeoutError.is(failure)) {
    return;
  }
  expect(failure.budget).toBe(budget);
  expect(failure.cause).toBe(cause);
  expect(failure.message).toContain(`${budget.milliseconds} ms`);
  expect(statements).toHaveLength(2);
});

test.each([
  {
    budget: AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
    expected: AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
  },
  {
    budget: AGGREGATE_TRANSACTION_BUDGETS.backgroundBatch,
    expected: AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
  },
  {
    budget: AGGREGATE_TRANSACTION_BUDGETS.skipLockedBatchPendingMeasurement,
    expected: AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
  },
])(
  "a scoped aggregate installs only the tighter declared or caller deadline ($budget.kind)",
  async ({ budget, expected }) => {
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
      async (tx) => {
        expect(getTransactionBudget(tx)).toBe(expected);
        await tx.execute(sql`SELECT 1`);
      },
    );
    const timeouts = statements.filter((statement) =>
      statement.includes("transaction_timeout"),
    );
    expect(timeouts).toEqual([
      `SET LOCAL transaction_timeout = ${expected.milliseconds}`,
    ]);
  },
);
