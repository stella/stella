# Reading authenticated link icon bytes for visible reply links

Generated from `scripts/ownership/chat-link-icon-bytes.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                             | Owner                                      | Enforcement                                                                       | Summary                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-link-icon-bytes` — Reading authenticated link icon bytes for visible reply links | `apps/web/src/features/chat/link-icons.ts` | import `linkIconsApi` from `@/lib/api`, `@/lib/eden-client` (plus 1 allowed file) | The web adapter deduplicates authenticated requests by hostname. Visible reply links retain local blob URLs until disposal; composer and restricted hosts keep bundled icons. |
