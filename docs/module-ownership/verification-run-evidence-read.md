# Reading persisted verification run evidence

Generated from `scripts/ownership/verification-run-evidence-read.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                     | Owner                                             | Enforcement                                                                       | Summary                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verification-run-evidence-read` — Reading persisted verification run evidence | `apps/api/src/lib/lists/verification/read-run.ts` | read `legalListVerificationRuns.evidence`, including implicit full-row selections | The verification run reader supplies contested fact identities, grading evidence and the list identity projection. Direct evidence column access and full-row reads stay inside the reader. |
