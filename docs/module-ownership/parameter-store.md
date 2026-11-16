# Reading deployment parameters

Generated from `scripts/ownership/parameter-store.ts`. See [Module ownership](../module-ownership.md).

| Capability                                        | Owner                       | Enforcement                  | Summary                                                                                                                                                                                               |
| ------------------------------------------------- | --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parameter-store` — Reading deployment parameters | `packages/parameter-store/` | import `@aws-sdk/client-ssm` | One parameter read returns a typed Result with a value and version, a five-second deadline, cancellation, and sanitized failure reasons. API configuration owns grant parsing and refresh scheduling. |
