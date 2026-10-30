import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  type AggregateTransactionBudget,
  tighterTransactionBudget,
} from "./aggregate-transaction-budget.ts";

const pendingBudget = new AsyncLocalStorage<{
  budget: AggregateTransactionBudget;
}>();
const transactionBudgets = new WeakMap<object, AggregateTransactionBudget>();

export const withTransactionBudgetContext = <T>(
  budget: AggregateTransactionBudget,
  run: () => T,
): T => pendingBudget.run({ budget }, run);

export const getPendingTransactionBudget = () =>
  pendingBudget.getStore()?.budget;

/** The pending policy belongs to transaction admission, not later transactions opened by its work. */
export const withoutPendingTransactionBudget = <T>(run: () => T): T =>
  pendingBudget.exit(run);

export const getTransactionBudget = (tx: object) => transactionBudgets.get(tx);

type TransactionBudgetExecutor = {
  execute: (statement: SQL) => PromiseLike<unknown>;
};

/** Claim before producing SQL: concurrent initializers cannot restart the deadline. */
const claimTransactionBudget = (
  tx: object,
  budget: AggregateTransactionBudget,
): void => {
  if (transactionBudgets.has(tx)) {
    panic("Transaction budget is already initialized");
  }
  transactionBudgets.set(tx, budget);
  // Admission may fail before the aggregate callback receives its transaction.
  // Keep its error boundary aware of the physical policy already selected.
  const admission = pendingBudget.getStore();
  if (admission !== undefined) {
    admission.budget = tighterTransactionBudget({
      declared: budget,
      requested: admission.budget,
    });
  }
};

/** Standalone admission stays a SET so callbacks can still choose their snapshot. */
export const initializeTransactionBudget = async (
  tx: TransactionBudgetExecutor,
  budget: AggregateTransactionBudget,
): Promise<void> => {
  claimTransactionBudget(tx, budget);
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

/** Scoped admission shares its first setup SELECT instead of adding a statement. */
export const prepareTransactionBudgetSetting = (
  tx: object,
  budget: AggregateTransactionBudget,
): SQL | undefined => {
  claimTransactionBudget(tx, budget);
  switch (budget.kind) {
    case "aggregate":
      return sql`set_config('transaction_timeout', ${`${budget.milliseconds}ms`}, true)`;
    case "uncapped-pending-measurement":
      return undefined;
    default:
      return panic("Unknown transaction budget kind", budget satisfies never);
  }
};

type BudgetedSetupReadOptions = {
  setting: SQL;
  statement: SQL;
};

/** Setup reads return at most one row. The correlated LIMIT forces the timer before their work, including empty identity lookups. */
export const budgetedSetupRead = ({
  setting,
  statement,
}: BudgetedSetupReadOptions): SQL => sql`
  WITH stella_budget AS MATERIALIZED (SELECT ${setting} AS applied)
  SELECT scoped_setup.* FROM stella_budget
  CROSS JOIN LATERAL (
    SELECT * FROM (${statement}) AS setup_read
    LIMIT CASE WHEN stella_budget.applied IS NOT NULL THEN 1 ELSE 0 END
  ) AS scoped_setup
`;

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
