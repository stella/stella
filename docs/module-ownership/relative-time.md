# Relative and absolute time formatting in the web client

Generated from `scripts/ownership/relative-time.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                | Owner                               | Enforcement | Summary                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relative-time` — Relative and absolute time formatting in the web client | `apps/web/src/lib/relative-time.ts` | none        | Relative-time output and the shared date/time format presets come from one module bound to the active formatting locale, so a rendered instant reads the same wherever it appears. The `require-relative-time-helpers` rule enforces it. |
