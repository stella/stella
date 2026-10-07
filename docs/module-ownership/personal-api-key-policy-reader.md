# Reading personal API key policy during credential verification

Generated from `scripts/ownership/personal-api-key-policy-reader.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                                        | Owner                                                         | Enforcement                                                                      | Summary                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `personal-api-key-policy-reader` — Reading personal API key policy during credential verification | `apps/api/src/lib/machine-api-keys/personal-policy-reader.ts` | import `@/api/lib/machine-api-keys/personal-policy-reader` (plus 1 allowed file) | The MCP authentication boundary can read policy without importing lifecycle mutations. |
