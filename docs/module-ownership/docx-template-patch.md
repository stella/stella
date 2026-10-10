# Rewriting OOXML parts inside an uploaded DOCX template

Generated from `scripts/ownership/docx-template-patch.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                     | Owner                                            | Enforcement | Summary                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docx-template-patch` — Rewriting OOXML parts inside an uploaded DOCX template | `apps/api/src/lib/docx/`, `packages/docx-utils/` | none        | Template patching edits the parts of a file a user supplied, preserving everything it does not touch. It shares only the zip and namespace helpers with `docx-authoring`. A third DOCX writer is not to be started. |
