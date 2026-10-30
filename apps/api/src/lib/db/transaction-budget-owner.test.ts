import { TaggedError } from "better-result";
import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  AGGREGATE_TRANSACTION_BUDGETS,
  tighterTransactionBudget,
} from "./aggregate-transaction-budget.ts";
import {
  getPendingTransactionBudget,
  getTransactionBudget,
  inheritTransactionBudget,
  initializeTransactionBudget,
  prepareTransactionBudgetSetting,
  withTransactionBudgetContext,
} from "./transaction-budget-owner.ts";

class TransactionOwnerFixtureError extends TaggedError(
  "TransactionOwnerFixtureError",
)<{
  message: string;
  code: string;
}> {}

const createExecutor = () => {
  const statements: string[] = [];
  const dialect = new PgDialect();
  const tx = {
    execute: async (statement: SQL) => {
      statements.push(dialect.sqlToQuery(statement).sql);
    },
  };
  return { tx, statements };
};

test.each(
  Object.values(AGGREGATE_TRANSACTION_BUDGETS).filter(
    (budget) => budget.kind !== "lease-coordinated",
  ),
)(
  "preparing a scoped budget claims its owner without executing SQL ($reason)",
  async (budget) => {
    const { tx, statements } = createExecutor();
    const setting = prepareTransactionBudgetSetting(tx, budget);
    expect(getTransactionBudget(tx)).toBe(budget);
    expect(statements).toEqual([]);
    switch (budget.kind) {
      case "aggregate": {
        expect(setting).toBeDefined();
        if (setting !== undefined) {
          const rendered = new PgDialect().sqlToQuery(setting);
          expect(rendered.sql).toBe(
            "set_config('transaction_timeout', $1, true)",
          );
          expect(rendered.params).toEqual([`${budget.milliseconds}ms`]);
        }
        break;
      }
      case "uncapped-pending-measurement":
        expect(setting).toBeUndefined();
        break;
      default:
        budget satisfies never;
    }
    expect(() => prepareTransactionBudgetSetting(tx, budget)).toThrow(
      "Transaction budget is already initialized",
    );
    expect(
      await rejectionOf(initializeTransactionBudget(tx, budget)),
    ).toMatchObject({
      message: "Transaction budget is already initialized",
    });
    expect(statements).toEqual([]);
  },
);

test("budget selection never weakens either boundary and preserves declared ownership on ties", () => {
  const policies = Object.values(AGGREGATE_TRANSACTION_BUDGETS)
    .filter((budget) => budget.kind !== "lease-coordinated")
    .map((budget) => ({
      budget,
      deadline: budget.kind === "aggregate" ? budget.milliseconds : Infinity,
    }));
  for (const declared of policies) {
    expect(
      tighterTransactionBudget({
        declared: declared.budget,
        requested: undefined,
      }),
    ).toBe(declared.budget);
    for (const requested of policies) {
      const selected = tighterTransactionBudget({
        declared: declared.budget,
        requested: requested.budget,
      });
      const deadline =
        selected.kind === "aggregate" ? selected.milliseconds : Infinity;
      expect(
        selected === declared.budget || selected === requested.budget,
      ).toBe(true);
      expect(deadline).toBeLessThanOrEqual(declared.deadline);
      expect(deadline).toBeLessThanOrEqual(requested.deadline);
      expect(deadline).toBe(Math.min(declared.deadline, requested.deadline));
      if (declared.deadline === requested.deadline) {
        expect(selected).toBe(declared.budget);
      }
      expect(
        tighterTransactionBudget({
          declared: selected,
          requested: declared.budget,
        }),
      ).toBe(selected);
      expect(
        tighterTransactionBudget({
          declared: selected,
          requested: requested.budget,
        }),
      ).toBe(selected);
    }
  }
});

test.each(
  Object.values(AGGREGATE_TRANSACTION_BUDGETS).filter(
    (budget) => budget.kind === "uncapped-pending-measurement",
  ),
)(
  "an uncapped owner claims its transaction without imposing a deadline ($entryPoint)",
  async (budget) => {
    const parent = createExecutor();
    const child = createExecutor();
    await initializeTransactionBudget(parent.tx, budget);
    inheritTransactionBudget(parent.tx, child.tx);
    expect(getTransactionBudget(parent.tx)).toBe(budget);
    expect(getTransactionBudget(child.tx)).toBe(budget);
    expect(parent.statements).toEqual([]);
    expect(child.statements).toEqual([]);
    expect(
      await rejectionOf(
        initializeTransactionBudget(
          parent.tx,
          AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
        ),
      ),
    ).toMatchObject({ message: "Transaction budget is already initialized" });
    expect(
      await rejectionOf(initializeTransactionBudget(child.tx, budget)),
    ).toMatchObject({ message: "Transaction budget is already initialized" });
    expect(parent.statements).toEqual([]);
    expect(child.statements).toEqual([]);
  },
);

test.each(
  Object.values(AGGREGATE_TRANSACTION_BUDGETS).filter(
    (budget) => budget.kind === "aggregate",
  ),
)(
  "a transaction initializes its selected budget exactly once ($reason)",
  async (budget) => {
    const { tx, statements } = createExecutor();
    expect(getTransactionBudget(tx)).toBeUndefined();
    await initializeTransactionBudget(tx, budget);
    expect(getTransactionBudget(tx)).toBe(budget);
    expect(statements).toEqual([
      `SET LOCAL transaction_timeout = ${budget.milliseconds}`,
    ]);
    expect(
      await rejectionOf(initializeTransactionBudget(tx, budget)),
    ).toMatchObject({
      message: "Transaction budget is already initialized",
    });
    expect(statements).toHaveLength(1);
  },
);

test("racing initializers cannot issue a second deadline statement", async () => {
  const pending = Promise.withResolvers<undefined>();
  let executions = 0;
  const tx = {
    execute: async () => {
      executions += 1;
      return await pending.promise;
    },
  };
  const firstBudget = AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe;
  const first = initializeTransactionBudget(tx, firstBudget);
  expect(getTransactionBudget(tx)).toBe(firstBudget);
  expect(
    await rejectionOf(
      initializeTransactionBudget(
        tx,
        AGGREGATE_TRANSACTION_BUDGETS.backgroundBatch,
      ),
    ),
  ).toMatchObject({ message: "Transaction budget is already initialized" });
  pending.resolve(undefined);
  await first;
  expect(executions).toBe(1);
  expect(getTransactionBudget(tx)).toBe(firstBudget);
});

test("savepoints inherit the deadline without SQL and cannot reset or replace it", async () => {
  const parent = createExecutor();
  const child = createExecutor();
  const grandchild = createExecutor();
  const budget = AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe;
  await initializeTransactionBudget(parent.tx, budget);
  inheritTransactionBudget(parent.tx, child.tx);
  inheritTransactionBudget(child.tx, grandchild.tx);
  expect(getTransactionBudget(child.tx)).toBe(budget);
  expect(getTransactionBudget(grandchild.tx)).toBe(budget);
  expect(child.statements).toEqual([]);
  expect(grandchild.statements).toEqual([]);
  expect(
    await rejectionOf(
      initializeTransactionBudget(
        child.tx,
        AGGREGATE_TRANSACTION_BUDGETS.backgroundBatch,
      ),
    ),
  ).toMatchObject({ message: "Transaction budget is already initialized" });
  expect(() => inheritTransactionBudget(parent.tx, child.tx)).toThrow(
    "Transaction budget is already initialized",
  );
  expect(child.statements).toEqual([]);
  expect(getTransactionBudget(child.tx)).toBe(budget);
  const legacyChild = createExecutor();
  inheritTransactionBudget({}, legacyChild.tx);
  expect(getTransactionBudget(legacyChild.tx)).toBeUndefined();
  expect(legacyChild.statements).toEqual([]);
});

test("concurrent transaction contexts retain their own budgets and restore their callers", async () => {
  const ready = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const firstBudget = AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe;
  const secondBudget = AGGREGATE_TRANSACTION_BUDGETS.backgroundBatch;
  const first = withTransactionBudgetContext(firstBudget, async () => {
    expect(getPendingTransactionBudget()).toBe(firstBudget);
    ready.resolve(undefined);
    await release.promise;
    expect(getPendingTransactionBudget()).toBe(firstBudget);
    const { tx } = createExecutor();
    await initializeTransactionBudget(tx, firstBudget);
    expect(getTransactionBudget(tx)).toBe(firstBudget);
    return firstBudget;
  });
  await ready.promise;
  expect(getPendingTransactionBudget()).toBeUndefined();
  const second = withTransactionBudgetContext(secondBudget, async () => {
    expect(getPendingTransactionBudget()).toBe(secondBudget);
    const { tx } = createExecutor();
    await initializeTransactionBudget(tx, secondBudget);
    expect(getTransactionBudget(tx)).toBe(secondBudget);
    const nested = withTransactionBudgetContext(firstBudget, () =>
      getPendingTransactionBudget(),
    );
    expect(nested).toBe(firstBudget);
    expect(getPendingTransactionBudget()).toBe(secondBudget);
    release.resolve(undefined);
    await first;
    expect(getPendingTransactionBudget()).toBe(secondBudget);
    return secondBudget;
  });
  expect(await Promise.all([first, second])).toEqual([
    firstBudget,
    secondBudget,
  ]);
  expect(getPendingTransactionBudget()).toBeUndefined();
});

test("initialization and context failures preserve their cause without permitting deadline retries", async () => {
  const budget = AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe;
  const cause = new TransactionOwnerFixtureError({
    message: "Connection failed while installing the transaction deadline",
    code: "08006",
  });
  let executions = 0;
  const tx = {
    execute: async () => {
      executions += 1;
      return await Promise.reject(cause);
    },
  };
  expect(await rejectionOf(initializeTransactionBudget(tx, budget))).toBe(
    cause,
  );
  expect(getTransactionBudget(tx)).toBe(budget);
  expect(
    await rejectionOf(initializeTransactionBudget(tx, budget)),
  ).toMatchObject({
    message: "Transaction budget is already initialized",
  });
  expect(executions).toBe(1);
  expect(
    await rejectionOf(
      withTransactionBudgetContext(
        budget,
        async () => await Promise.reject(cause),
      ),
    ),
  ).toBe(cause);
  expect(getPendingTransactionBudget()).toBeUndefined();
});
