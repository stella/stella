# Issuing opaque document session credentials

Generated from `scripts/ownership/document-session-credentials.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                   | Owner                                        | Enforcement                                                                               | Summary                                                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `document-session-credentials` — Issuing opaque document session credentials | `apps/api/src/lib/entities/opaque-tokens.ts` | import `createOpaqueToken` from `@/api/lib/entities/opaque-tokens` (plus 3 allowed files) | Document credential owners apply the principal policy before issuing a token. Collaboration credentials also retain their source session. |
