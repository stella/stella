# Cursor query fields on list endpoints

Generated from `scripts/ownership/pagination-cursor-schema.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                         | Owner                               | Enforcement | Summary                                                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pagination-cursor-schema` — Cursor query fields on list endpoints | `apps/api/src/lib/custom-schema.ts` | none        | Cursor query fields come from `tPaginationCursor`, so the byte cap is one named constant rather than a literal repeated per route. |
