# Resuming retained signals work after a principal grant

Generated from `scripts/ownership/signals-grant-recovery.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                        | Owner                                            | Enforcement                                                         | Summary                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `signals-grant-recovery` — Resuming retained signals work after a principal grant | `apps/api/src/lib/signals/resume-after-grant.ts` | import `@/api/lib/signals/resume-after-grant` (plus 1 allowed file) | Rechecks live membership and grant under the admission lock, constrains sources to the principal's matters, and returns no feature data. |
