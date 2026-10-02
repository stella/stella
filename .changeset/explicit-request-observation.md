---
"@stll/business-registries": minor
---

Registry lookup, search and entity-check calls now require an `observer` in their options or client configuration. Set `observer` to `"unobserved"`, or `{ onRequest, onError }`: `onRequest` runs once before each outbound request, and `onError` receives anything `onRequest` throws (the request still proceeds). The type is `RegistryRequestObservation` from `@stll/business-registries/shared/request-observer`. The global `observeRegistryRequests` and `notifyRegistryRequest` exports are removed.
