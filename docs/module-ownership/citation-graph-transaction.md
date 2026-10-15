# Acquiring the citation graph transaction lock

Generated from `scripts/ownership/citation-graph-transaction.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                   | Owner                                                          | Enforcement                                                       | Summary                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `citation-graph-transaction` — Acquiring the citation graph transaction lock | `apps/api/src/handlers/case-law/citation-graph-transaction.ts` | literal pattern `citation_resolution_walk` (plus 4 allowed files) | The graph owner acquires its advisory lock before domain row locks and passes a branded transaction to graph writers. The conditional owner declines busy walks before reading their cursor. |
