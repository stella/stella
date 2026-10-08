# Issuing third-party request authority

Generated from `scripts/ownership/third-party-outbound-permit.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                            | Owner                                                  | Enforcement                                                                                                      | Summary                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `third-party-outbound-permit` — Issuing third-party request authority | `apps/api/src/lib/auth/third-party-outbound-permit.ts` | import `grantThirdPartyOutboundPermit` from `@/api/lib/auth/third-party-outbound-permit` (plus 42 allowed files) | Direct request, job and operator boundaries issue the identities checked by the shared outbound request owner. |
