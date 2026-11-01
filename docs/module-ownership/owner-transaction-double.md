# Owner transaction test doubles

Generated from `scripts/ownership/owner-transaction-double.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                  | Owner                                   | Enforcement                                                                              | Summary                                                                                                                                                       |
| ----------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner-transaction-double` — Owner transaction test doubles | `apps/api/src/lib/db/aggregate-lock.ts` | import `ownerTransactionDouble` from `@/api/lib/db/aggregate-lock` (plus 1 allowed file) | Owner-held row locks refuse any transaction that withOwnerAggregateTransaction did not open. Only test helpers may register a double as an owner transaction. |
