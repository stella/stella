# Admitting process-bound work

Generated from `scripts/ownership/work-admission.ts`. See [Module ownership](../module-ownership.md).

| Capability                                      | Owner                                     | Enforcement                                                                   | Summary                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `work-admission` — Admitting process-bound work | `apps/api/src/lib/load/work-admission.ts` | import `admitWork` from `@/api/lib/load/work-admission` (plus 1 allowed file) | Memory-heavy work carries a short-lived admission proof from a named process pool. Only the current consumers may mint proofs. |
