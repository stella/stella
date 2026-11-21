# Claiming desktop device proofs once

Generated from `scripts/ownership/desktop-device-proof-replay.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                          | Owner                                                         | Enforcement                                                                       | Summary                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `desktop-device-proof-replay` — Claiming desktop device proofs once | `apps/api/src/lib/business-registries/desktop/proof-store.ts` | import `@/api/lib/business-registries/desktop/proof-store` (plus 8 allowed files) | The denied replay table records each verified proof once independently of business transactions. Indexed pruning removes only its expired rows in bounded batches. |
