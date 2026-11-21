# Checking stored object admission

Generated from `scripts/ownership/file-reservation-checks.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                   | Owner                                               | Enforcement                                                                                                           | Summary                                                           |
| ------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `file-reservation-checks` — Checking stored object admission | `apps/api/src/lib/files/organization-file-usage.ts` | import `reserveOrganizationFileBytes`, `reserveOrganizationFilesBytes` from `@/api/lib/files/organization-file-usage` | Reservation writes run through the owner's admitted continuation. |
