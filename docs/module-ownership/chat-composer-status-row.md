# Chat composer status-row assembly and loading state

Generated from `scripts/ownership/chat-composer-status-row.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                       | Owner                                                 | Enforcement                                                               | Summary                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-composer-status-row` — Chat composer status-row assembly and loading state | `apps/web/src/components/chat/chat-composer-dock.tsx` | import `ComposerStatusRow` from `@stll/ui/composer` (plus 1 allowed file) | ChatComposerDock owns the pending/ready discriminator and the canonical control order, so loading keeps every known icon and fixed dimension while only unresolved values render a skeleton. |
