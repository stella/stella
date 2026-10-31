import {
  AGGREGATE_TRANSACTION_BUDGETS,
  type AggregateTransactionBudget,
} from "./aggregate-transaction-budget";

export const overMigrationLockBudget: AggregateTransactionBudget = {
  ...AGGREGATE_TRANSACTION_BUDGETS.migrationCeiling,
  // @ts-expect-error Aggregate transactions must end before the online-DDL ladder.
  milliseconds: 120_000,
};

// @ts-expect-error Lease-coordinated corpus owners are not aggregate timeout policies.
export const dedicatedBudgetIsNotAggregate: AggregateTransactionBudget =
  AGGREGATE_TRANSACTION_BUDGETS.legislationFacetRefresh;
