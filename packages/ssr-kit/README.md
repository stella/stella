# `@stll/ssr-kit`

Small framework-neutral primitives for applications that mix server-rendered
public routes with client-rendered application routes.

Path policies use discriminated exact and subtree rules. Subtree matching is
segment-aware, so `/docs` matches `/docs/start` but never `/docs-private`.

```ts
import { createPathMatcher } from "@stll/ssr-kit";

const isServerRendered = createPathMatcher([
  { type: "subtree", path: "/docs" },
]);
```

The hydration entry keeps ordering explicit. An SSR document hydrates first,
then initializes browser-owned state after paint; a client-only document
initializes that state before its first render.

```ts
import { bootHydratedClient } from "@stll/ssr-kit/hydration";

await bootHydratedClient({
  type: "server-rendered",
  hydrate,
  initializeClientState,
});
```
