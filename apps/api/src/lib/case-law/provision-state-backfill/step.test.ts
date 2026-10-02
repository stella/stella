import { Result } from "better-result";
import { expect, test } from "bun:test";

import { inBackfillTransaction, ProvisionBackfillUnitError } from "./step";
import type { ProvisionBackfillSession } from "./step";

for (const statementTimeout of [60_000, 25 * 60_000]) {
  test(`runtime-owned units keep the ${statementTimeout}ms budget without nesting transactions`, async () => {
    const statements: string[] = [];
    const budgets: { lockTimeout: number; statementTimeout: number }[] = [];
    const session: ProvisionBackfillSession = {
      execute: async (statement) => {
        statements.push(statement);
      },
      query: async () => [],
      setTransactionBudget: async () => {
        throw new TypeError("unit must delegate the transaction budget");
      },
      runUnit: async (budget, work) => {
        budgets.push(budget);
        return await Result.tryPromise({
          try: work,
          catch: (cause) =>
            new ProvisionBackfillUnitError({ message: "unit failed", cause }),
        });
      },
    };
    const result = await inBackfillTransaction(
      session,
      { lockTimeout: 10_000, statementTimeout },
      async () => {
        await session.execute("bounded work");
      },
    );
    expect(result.isOk()).toBe(true);
    expect(statements).toEqual(["bounded work"]);
    expect(budgets).toEqual([{ lockTimeout: 10_000, statementTimeout }]);
  });
}
