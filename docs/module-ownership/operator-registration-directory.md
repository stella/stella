# Serving audited operator registration pages

Generated from `scripts/ownership/operator-registration-directory.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                      | Owner                     | Enforcement                                                                      | Summary                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator-registration-directory` — Serving audited operator registration pages | `apps/api/src/db/root.ts` | import `readOperatorRegistrationPage` from `@/api/db/root` (plus 1 allowed file) | Reads bounded registration pages through the owner connection and records each read transactionally; callers receive only the declared directory fields, never a database handle. |
