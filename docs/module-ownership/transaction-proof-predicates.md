# Checking facts for transaction-bound proofs

Generated from `scripts/ownership/transaction-proof-predicates.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                   | Owner                                                                                                                  | Enforcement                                                                 | Summary                                                                                                                     |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `transaction-proof-predicates` — Checking facts for transaction-bound proofs | `apps/api/src/lib/signals/proofs/signal-visible-to.ts`, `apps/api/src/lib/signals/proofs/may-create-signal-request.ts` | import `withCheckedTransaction` from `@/api/lib/proofs/checked-transaction` | Only trusted predicate modules may invoke the shared proof boundary; operation callers use their domain checking functions. |
