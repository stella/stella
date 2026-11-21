# Measured API test memory and batch composition

Generated from `scripts/ownership/api-test-memory-planner.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                 | Owner                                 | Enforcement                                  | Summary                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api-test-memory-planner` — Measured API test memory and batch composition | `apps/api/scripts/test-batch-plan.ts` | import `apps/api/scripts/test-peak-rss.json` | The planner owns measured peak RSS, conservative unknown weights and automatic process isolation. Batch plans must fit their execution-class memory caps before a test starts. |
