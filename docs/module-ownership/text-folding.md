# Diacritic and ASCII folding for search and slugs

Generated from `scripts/ownership/text-folding.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                        | Owner                      | Enforcement | Summary                                                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text-folding` — Diacritic and ASCII folding for search and slugs | `packages/text-normalize/` | none        | Folding decides which strings compare equal, so search, highlighting, and slugs have to agree on it. Build slug helpers on the folds exported here rather than on a local regex. |
