# `@stll/ssr-testkit`

Runtime-agnostic assertions for the observable HTML contract of an SSR route.
The caller adapts its HTTP or browser response into a small observation; the
testkit verifies status, HTML content type, required server-rendered markers,
and content that must not appear.

```ts
import { assertSsrDocument } from "@stll/ssr-testkit";

assertSsrDocument({
  html,
  status: response.status(),
  contentType: response.headers()["content-type"] ?? null,
  requiredContent: ["<main", "Catalogue"],
  forbiddenContent: ["private account"],
});
```

The package has no dependency on Playwright, a DOM implementation, or a
particular server framework.
