# Price recorded time with its no-charge disposition

Generated from `scripts/ownership/time-entry-amount.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                               | Owner             | Enforcement                                    | Summary                                                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time-entry-amount` — Price recorded time with its no-charge disposition | `packages/money/` | import `prorateHourlyCents` from `@stll/money` | timeEntryAmount requires the noCharge field and returns zero for no-charge time. Invoice lines, exports and displayed time amounts use this calculation. |
