# Transferring initialized maintenance session ownership

Generated from `scripts/ownership/maintenance-session-initialization.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                                    | Owner                                           | Enforcement                                                                                            | Summary                                                           |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `maintenance-session-initialization` — Transferring initialized maintenance session ownership | `apps/api/src/lib/case-law/maintenance-lane.ts` | import `createMaintenanceLaneSession` from `@/api/lib/case-law/maintenance-lane` (plus 1 allowed file) | Initialization failures release the held lane before propagating. |
