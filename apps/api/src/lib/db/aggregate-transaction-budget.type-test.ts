import {
  AGGREGATE_TRANSACTION_BUDGETS,
  type AggregateTransactionBudget,
} from "./aggregate-transaction-budget";

export const overMigrationLockBudget: AggregateTransactionBudget = {
  kind: "aggregate",
  // @ts-expect-error Aggregate transactions may not outwait online DDL.
  milliseconds: 120_001,
  reason: "online-DDL lock retry ceiling",
};

// @ts-expect-error Dedicated corpus owners retain their connection deadline, not an aggregate timeout.
export const dedicatedBudgetIsNotAggregate: AggregateTransactionBudget =
  AGGREGATE_TRANSACTION_BUDGETS.legislationFacetRefresh;
