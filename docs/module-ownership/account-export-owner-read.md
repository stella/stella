# Reading account export data under account ownership

Generated from `scripts/ownership/account-export-owner-read.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                        | Owner                                           | Enforcement                                                                                                                  | Summary                                                                                            |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `account-export-owner-read` — Reading account export data under account ownership | `apps/api/src/lib/account-export/owner-read.ts` | import `SETTING_ACCOUNT_EXPORT_USER_ID`, `SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID` from `@/api/db/rls` (plus 2 allowed files) | Sets account-export user and organization scope on the root connection before account-owned reads. |
