# Locale-aware sorting of human-readable text

Generated from `scripts/ownership/collation.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                | Owner                 | Enforcement | Summary                                                                                                                                                                                                     |
| --------------------------------------------------------- | --------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collation` — Locale-aware sorting of human-readable text | `packages/collation/` | none        | Constructing an `Intl.Collator` per comparison is a documented hot-path cost, so the package caches one per locale behind a bounded LRU; `require-cached-collator` routes every `localeCompare` through it. |
