# Generating opaque organization slugs

Generated from `scripts/ownership/organization-opaque-slug.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                        | Owner                                 | Enforcement                                          | Summary                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization-opaque-slug` — Generating opaque organization slugs | `packages/auth-model/src/contract.ts` | literal pattern `^abcdefghijklmnopqrstuvwxyz234567$` | Organization creation and slug changes generate the same org- identifier from one fixed-size random buffer; slug length and character rules come from ORGANIZATION_SLUG_RULES next to it. |
