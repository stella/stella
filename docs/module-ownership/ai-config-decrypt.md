# Organization AI settings decryption

Generated from `scripts/ownership/ai-config-decrypt.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                | Owner                                  | Enforcement                                                                                                                                                  | Summary                                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ai-config-decrypt` — Organization AI settings decryption | `apps/api/src/lib/ai-config-crypto.ts` | import `decryptAIConfig`, `unreadableOrgAIConfig`, `OrgAIConfigReadError`, `OrgAIConfigReadFailure` from `@/api/lib/ai-config-crypto` (plus 9 allowed files) | Decrypted provider credentials stay behind the runtime settings readers and settings editing handlers; tests may exercise the boundary directly. |
