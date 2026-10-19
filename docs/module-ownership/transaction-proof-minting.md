# Minting transaction-bound checked proofs

Generated from `scripts/ownership/transaction-proof-minting.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                             | Owner                                                                                                  | Enforcement                              | Summary                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transaction-proof-minting` — Minting transaction-bound checked proofs | `apps/api/src/lib/proofs/checked-transaction.ts`, `apps/api/src/lib/workspaces/matter-access-proof.ts` | import `defineProof` from `@gdp-ts/core` | The shared proof core names the actor, entity and transaction, runs the trusted predicate, and supplies evidence only after success. Predicate modules retain their domain checks. |
