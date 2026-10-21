# Identifying the dedicated monitoring principal

Generated from `scripts/ownership/synthetic-principal.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                             | Owner                                   | Enforcement                                                                                        | Summary                                                                                                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synthetic-principal` — Identifying the dedicated monitoring principal | `apps/api/src/lib/synthetic-principal/` | import `SYNTHETIC_PRINCIPAL` from `@/api/lib/synthetic-principal/constants` (plus 2 allowed files) | Consumers identify the monitoring principal through isSyntheticPrincipal. Stable identity literals belong to its provisioning owner and the database constraints. |
