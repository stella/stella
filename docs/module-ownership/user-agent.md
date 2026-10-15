# Browser and OS names parsed from a user-agent string

Generated from `scripts/ownership/user-agent.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                          | Owner                  | Enforcement | Summary                                                                                                                                      |
| ------------------------------------------------------------------- | ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `user-agent` — Browser and OS names parsed from a user-agent string | `packages/user-agent/` | none        | One parser feeds session listings on the api and the device labels in the web client, so a new browser family is recognised in both at once. |
