# Serving audited operator activity aggregates

Generated from `scripts/ownership/operator-activity-summary.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                 | Owner                     | Enforcement                                                                     | Summary                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator-activity-summary` — Serving audited operator activity aggregates | `apps/api/src/db/root.ts` | import `readOperatorActivitySummary` from `@/api/db/root` (plus 1 allowed file) | Reads deployment-wide bounded time-window counts through the owner connection and records each read transactionally; callers receive aggregates, never a database handle. |
