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

The hydration entry keeps ordering explicit. An SSR document reports when its
hydration commit completes, then initializes browser-owned state; a client-only
document initializes that state before its first render.

```ts
import { bootHydratedClient } from "@stll/ssr-kit/hydration";

await bootHydratedClient({
  type: "server-rendered",
  hydrate: hydrateAndWaitForCommit,
  initializeClientState,
});
```

`hydrateAndWaitForCommit` must resolve from the hydration tree's layout effect,
not when the framework's hydrate function returns.
