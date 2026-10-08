# Owning deferred document writes

Generated from `scripts/ownership/deferred-document-source-ownership.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                             | Owner                                                   | Enforcement                                                        | Summary                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `deferred-document-source-ownership` — Owning deferred document writes | `apps/api/src/lib/legal-search/sk-document-backfill.ts` | import `@/api/lib/legal-search/deferred-document-source-ownership` | Deferred document operations acquire source ownership before remote and database effects. Raw write functions stay within the writer module. |
