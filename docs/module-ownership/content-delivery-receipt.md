# Recording a content-delivery audit receipt

Generated from `scripts/ownership/content-delivery-receipt.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                              | Owner                                        | Enforcement                                                                                          | Summary                                                                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `content-delivery-receipt` — Recording a content-delivery audit receipt | `apps/api/src/lib/files/content-delivery.ts` | import `recordContentDeliveryReceipt` from `@/api/lib/files/content-delivery` (plus 3 allowed files) | The handler invocation owns the delivery scope; response and audit owners record their corresponding events through named entry points. |
