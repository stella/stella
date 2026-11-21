# String HTML and XML tree loading

Generated from `scripts/ownership/html-loader.ts`. See [Module ownership](../module-ownership.md).

| Capability                                       | Owner                                                                                                                                                     | Enforcement | Summary                                                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `html-loader` — String HTML and XML tree loading | `packages/html/src/load.ts`, `packages/html/src/nodes.ts`, `packages/html/src/selection.ts`, `packages/html/src/email.ts`, `packages/html/src/bounded.ts` | none        | Tree-based HTML consumers use @stll/html; Node and selection types, email serialization and bounded parsing share that owner. One-pass extractors may use HTMLRewriter. |
