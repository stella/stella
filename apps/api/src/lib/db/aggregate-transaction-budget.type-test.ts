import type { AggregateTransactionBudget } from "./aggregate-transaction-budget";

export const overMigrationLockBudget: AggregateTransactionBudget = {
  // @ts-expect-error Aggregate transactions may not outwait online DDL.
  milliseconds: 120_001,
  reason: "online-DDL lock retry ceiling",
};
