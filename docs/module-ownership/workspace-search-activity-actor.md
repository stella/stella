# Minting the workspace search activity scope actor

Generated from `scripts/ownership/workspace-search-activity-actor.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                            | Owner                                                    | Enforcement                                                                                                           | Summary                                                                                                        |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `workspace-search-activity-actor` — Minting the workspace search activity scope actor | `apps/api/src/lib/db/workspace-search-activity-actor.ts` | import `createWorkspaceSearchActivityActor` from `@/api/lib/db/workspace-search-activity-actor` (plus 1 allowed file) | The private actor contract is shared as a type, while only search bookkeeping may construct its runtime brand. |
