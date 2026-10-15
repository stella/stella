# Rendering an uploaded file to a PDF derivative

Generated from `scripts/ownership/pdf-rendering.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                       | Owner                                 | Enforcement | Summary                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pdf-rendering` — Rendering an uploaded file to a PDF derivative | `apps/api/src/lib/files/gotenberg.ts` | none        | One module talks to the conversion service, so the timeout, the spreadsheet fit-to-page pre-processing, and the derivative policy that decides which MIME types convert stay together. |
