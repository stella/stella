# Monetary amounts and minor-unit arithmetic

Generated from `scripts/ownership/money-arithmetic.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                      | Owner             | Enforcement | Summary                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ----------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `money-arithmetic` — Monetary amounts and minor-unit arithmetic | `packages/money/` | none        | Amounts are stored and computed in minor units behind a `CentsAmount` brand, so a major-unit value cannot be mixed into minor-unit math. The brand threads from the Drizzle column through the API boundary into the browser only while every producer mints it here. |
