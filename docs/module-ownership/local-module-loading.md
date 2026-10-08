# Loading local modules inside a declared directory

Generated from `scripts/ownership/local-module-loading.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                 | Owner                                               | Enforcement | Summary                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-module-loading` — Loading local modules inside a declared directory | `packages/start-runtime/src/local-module-loader.ts` | none        | The local loader resolves root and entry real paths before importing. scripts/outbound-transport-ownership.ts confines dynamic imports to this owner and enumerates its callers through the transport census; the indirect acquisition ratchet stays at zero. |
