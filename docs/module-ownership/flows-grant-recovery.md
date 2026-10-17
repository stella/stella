# Resuming retained flows work after a principal grant

Generated from `scripts/ownership/flows-grant-recovery.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                    | Owner                                          | Enforcement                                                       | Summary                                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `flows-grant-recovery` — Resuming retained flows work after a principal grant | `apps/api/src/lib/flows/resume-after-grant.ts` | import `@/api/lib/flows/resume-after-grant` (plus 1 allowed file) | Rechecks live membership and grant under the admission lock, constrains sources to the principal's matters, and returns no feature data. |
