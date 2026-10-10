# Reading persisted audit changes

Generated from `scripts/ownership/audit-detail-read.ts`. See [Module ownership](../module-ownership.md).

| Capability                                            | Owner                                   | Enforcement                                                      | Summary                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-detail-read` — Reading persisted audit changes | `apps/api/src/lib/audit-log-details.ts` | read `auditLogs.changes`, including implicit full-row selections | The audit detail owner supplies caller-aware change selections and projections. Direct column access and implicit full-row reads stay inside this owner; database assertions remain in test files excluded from the production ownership rule. |
