# Recording the signed-in account's professional-use acceptance

Generated from `scripts/ownership/professional-use-acceptance.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                                    | Owner                                       | Enforcement                                                                                         | Summary                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `professional-use-acceptance` — Recording the signed-in account's professional-use acceptance | `apps/api/src/lib/auth/professional-use.ts` | import `recordAccountProfessionalUse` from `@/api/lib/auth/professional-use` (plus 3 allowed files) | Records insert-once account and organization acceptances with account-level serialization and transactional audit rows. |
