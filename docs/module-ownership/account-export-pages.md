# Reading bounded personal export pages across account memberships

Generated from `scripts/ownership/account-export-pages.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                                | Owner                                      | Enforcement | Summary                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account-export-pages` — Reading bounded personal export pages across account memberships | `apps/api/src/lib/account-export/pages.ts` | none        | The page reader resolves the dedicated RLS transaction pool and binds the requesting account independently of an active organization. It calls each table owner's projection; export lifecycle writes remain confined to the durable ledger owner. |
