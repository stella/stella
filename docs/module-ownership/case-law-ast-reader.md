# Parsing stored case-law decision ASTs for reads

Generated from `scripts/ownership/case-law-ast-reader.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                              | Owner                                       | Enforcement                                                                               | Summary                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `case-law-ast-reader` — Parsing stored case-law decision ASTs for reads | `packages/legal-ast/src/case-law-reader.ts` | import `parseUsableDocumentAst` from `@stll/legal-ast/document-ast` (plus 1 allowed file) | Every case-law read parses degraded persisted ASTs and applies structural repairs through `parseCaseLawDecisionAst`, so web, MCP, search, research and analysis observe the same headings. |
