# Running narrowly declared tenantless system work

Generated from `scripts/ownership/global-system-work.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                              | Owner                                       | Enforcement                                                                                | Summary                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `global-system-work` — Running narrowly declared tenantless system work | `apps/api/src/lib/db/global-system-work.ts` | import `runGlobalSystemWork` from `@/api/lib/db/global-system-work` (plus 3 allowed files) | The system database door accepts closed literal intents for its listed cleanup jobs; each intent is callable only from its source owner. |
