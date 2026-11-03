# Decoding RTF control words and bytes

Generated from `scripts/ownership/rtf-reader.ts`. See [Module ownership](../module-ownership.md).

| Capability                                          | Owner                                                                                                                    | Enforcement                                      | Summary                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rtf-reader` — Decoding RTF control words and bytes | `apps/api/src/lib/legal-search/parsers/rtf-reader.ts`, `apps/api/src/lib/legal-search/parsers/rtf-control-vocabulary.ts` | literal pattern `ansicpg` (plus 7 allowed files) | All source parsers consume the shared RTF document reader. The document code-page control stays confined to that reader; fixtures may state it as input. |
