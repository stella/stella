# Binding the public sanctions reader to the scoped connection pool

Generated from `scripts/ownership/public-sanctions-reader-binding.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                                            | Owner                     | Enforcement                                                                     | Summary                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `public-sanctions-reader-binding` — Binding the public sanctions reader to the scoped connection pool | `apps/api/src/db/root.ts` | import `createPublicSanctionsReader` from `@/api/db/root` (plus 1 allowed file) | The connection owner constructs a column-restricted, read-only sanctions reader without exporting another raw connection handle. |
