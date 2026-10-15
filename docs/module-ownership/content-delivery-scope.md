# Running and checking the content-delivery scope

Generated from `scripts/ownership/content-delivery-scope.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                 | Owner                                        | Enforcement                                                                                                                          | Summary                                                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `content-delivery-scope` — Running and checking the content-delivery scope | `apps/api/src/lib/files/content-delivery.ts` | import `runWithContentDeliveryScope`, `getContentDeliveryReceiptError` from `@/api/lib/files/content-delivery` (plus 1 allowed file) | The handler invocation owns the delivery scope; response and audit owners record their corresponding events through named entry points. |
