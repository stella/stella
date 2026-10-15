# Deciding which roles reach a matter without an assignment

Generated from `scripts/ownership/matter-reach-rule.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                      | Owner                                       | Enforcement                                                       | Summary                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matter-reach-rule` — Deciding which roles reach a matter without an assignment | `apps/api/src/lib/workspaces/visibility.ts` | import `ORGANIZATION_MATTER_ADMIN_ROLES` from `@stll/permissions` | The matter visibility module states the reach rule once, as a TypeScript check and as SQL predicates over any matter alias. Every other check, query and lock path asks it instead of comparing roles itself. |
