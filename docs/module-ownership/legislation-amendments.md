# Persisting and reading publisher-stated provision amendment effects

Generated from `scripts/ownership/legislation-amendments.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                                     | Owner                                                     | Enforcement | Summary                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legislation-amendments` — Persisting and reading publisher-stated provision amendment effects | `apps/api/src/lib/legal-search/legislation-amendments.ts` | none        | The owner replaces work-scoped publisher snapshots atomically and pages incoming and outgoing effects by publisher identity. Readers share it rather than inferring amending acts from consolidation dates. |
