# Renewing account-bound desktop credentials

Generated from `scripts/ownership/desktop-account-renewal.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                             | Owner                                                     | Enforcement                                                                   | Summary                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-account-renewal` — Renewing account-bound desktop credentials | `apps/api/src/lib/business-registries/desktop/renewal.ts` | import `@/api/lib/business-registries/desktop/renewal` (plus 3 allowed files) | Renewal locks live membership and the purpose-bound credential, rotates its digest and inactivity deadline, and commits its audit in the same transaction. Recovery probes preserve the deadline. |
