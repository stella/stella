# Recording stored-content delivery intent

Generated from `scripts/ownership/content-delivery-intent.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                           | Owner                                        | Enforcement                                                                                       | Summary                                                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `content-delivery-intent` — Recording stored-content delivery intent | `apps/api/src/lib/files/content-delivery.ts` | import `markContentDeliveryIntent` from `@/api/lib/files/content-delivery` (plus 3 allowed files) | The handler invocation owns the delivery scope; response and audit owners record their corresponding events through named entry points. |
