# Provisioning and revoking dedicated monitoring sessions

Generated from `scripts/ownership/monitoring-session-store.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                           | Owner                                           | Enforcement | Summary                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | ----------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monitoring-session-store` — Provisioning and revoking dedicated monitoring sessions | `apps/api/src/lib/synthetic-principal/store.ts` | none        | The fixed-principal session owner uses the owner connection for auth records and a control table ordinary requests cannot access. Mint and revoke serialize through the control row and audit before commit; no connection is exported. |
