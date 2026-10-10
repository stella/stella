# Admitting dedicated database sessions within one process ceiling

Generated from `scripts/ownership/dedicated-database-connections.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                                          | Owner                                           | Enforcement                                                         | Summary                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `dedicated-database-connections` — Admitting dedicated database sessions within one process ceiling | `apps/api/src/db/dedicated-connection-slots.ts` | import `@/api/db/dedicated-connection-slots` (plus 2 allowed files) | The owner admits maintenance sessions and cancellable work together, reserving cancellation capacity before work opens. |
