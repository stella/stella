# Web form validation and submission normalization

Generated from `scripts/ownership/schema-form-options.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                               | Owner                        | Enforcement | Summary                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema-form-options` — Web form validation and submission normalization | `apps/web/src/lib/schema.ts` | none        | schemaFormOptions wires dynamic validation and requires a schema-output or raw submission choice. Valibot owns field transformations; callbacks receive the selected input or output type. require-schema-form-options routes every production web form through this contract. |
