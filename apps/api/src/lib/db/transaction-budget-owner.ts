import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";

import type { AggregateTransactionBudget } from "./aggregate-transaction-budget.ts";

const pendingBudget = new AsyncLocalStorage<AggregateTransactionBudget>();
const transactionBudgets = new WeakMap<object, AggregateTransactionBudget>();

export const withTransactionBudgetContext = <T>(
  budget: AggregateTransactionBudget,
  run: () => T,
): T => pendingBudget.run(budget, run);

export const getPendingTransactionBudget = () => pendingBudget.getStore();

/** The pending policy belongs to transaction admission, not later transactions opened by its work. */
export const withoutPendingTransactionBudget = <T>(run: () => T): T =>
  pendingBudget.exit(run);

export const getTransactionBudget = (tx: object) => transactionBudgets.get(tx);

type TransactionBudgetExecutor = {
  execute: (statement: SQL) => PromiseLike<unknown>;
};

/** Claim before awaiting SQL: concurrent initializers cannot restart the deadline. */
export const initializeTransactionBudget = async (
  tx: TransactionBudgetExecutor,
  budget: AggregateTransactionBudget,
): Promise<void> => {
  if (transactionBudgets.has(tx)) {
    panic("Transaction budget is already initialized");
  }
  transactionBudgets.set(tx, budget);
  switch (budget.kind) {
    case "aggregate":
      await tx.execute(
        sql.raw(`SET LOCAL transaction_timeout = ${budget.milliseconds}`),
      );
      return;
    case "uncapped-pending-measurement":
      return;
    default:
      return panic("Unknown transaction budget kind", budget satisfies never);
  }
};

/** Savepoints share their physical transaction's deadline; they never reset it. */
export const inheritTransactionBudget = (
  parent: object,
  child: object,
): void => {
  const budget = transactionBudgets.get(parent);
  if (budget === undefined) {
    return;
  }
  if (transactionBudgets.has(child)) {
    panic("Transaction budget is already initialized");
  }
  transactionBudgets.set(child, budget);
};
