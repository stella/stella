import { expect, test } from "bun:test";
import { sql, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { AGGREGATE_TRANSACTION_BUDGETS } from "@/api/lib/db/aggregate-transaction-budget";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { createScopedDb, createTenantlessDb, markRlsDatabase } from "./scoped";

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

test.each(["scoped", "tenantless"] as const)(
  "%s request initializes its deadline before its first scoped SQL",
  async (scope) => {
    const { database, statements } = fixture();
    const run =
      scope === "scoped"
        ? createScopedDb(
            database,
            [],
            mintAuthProviderId<"organization">(),
            null,
          )
        : createTenantlessDb(database);
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

test.each([
  AGGREGATE_TRANSACTION_BUDGETS.requestPath,
  AGGREGATE_TRANSACTION_BUDGETS.backgroundBatch,
  AGGREGATE_TRANSACTION_BUDGETS.skipLockedBatchPendingMeasurement,
])(
  "a scoped aggregate keeps its caller's single deadline owner ($kind)",
  async (budget) => {
    const { database, statements } = fixture();
    const scoped = createScopedDb(
      database,
      [],
      mintAuthProviderId<"organization">(),
      null,
    );
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
