# Sending bounded outbound requests

Generated from `scripts/ownership/outbound-request-transport.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                       | Owner                                     | Enforcement | Summary                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbound-request-transport` — Sending bounded outbound requests | `apps/api/src/lib/safe-outbound-fetch.ts` | none        | Byte and stream requests carry an issued permit. scripts/outbound-transport-ownership.ts enumerates API transport acquisition against the classified owner census in scripts/outbound-transport-census.ts. |
