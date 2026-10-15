# Reading the public sanctions corpus for anonymous screening

Generated from `scripts/ownership/public-sanctions-screening.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                                 | Owner                                                   | Enforcement                                                                | Summary                                                                                                                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `public-sanctions-screening` — Reading the public sanctions corpus for anonymous screening | `apps/api/src/lib/lists/sanctions/public-read-owner.ts` | import `@/api/lib/lists/sanctions/public-read-owner` (plus 1 allowed file) | Anonymous screening uses a column-restricted reader role and read-only transactions. This owner exports the restricted screening handle. |
