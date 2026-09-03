# `@stll/start-runtime`

Bun runtime primitives for a built TanStack Start application. The package
keeps serving mechanics outside an application's route and rendering code:

- validate the Start fetch handler before accepting traffic;
- serve client assets with bounded path resolution and cache policy;
- expose a no-store health response;
- apply host-owned response headers consistently;
- resolve every emitted server module before startup; and
- bind the resulting fetch handler through `Bun.serve`.

The host still owns environment parsing, security-header values, logging, and
the locations of its build artifacts.

```ts
import {
  createStartRuntime,
  serveStartRuntime,
  verifyServerModuleGraph,
} from "@stll/start-runtime";

const verification = await verifyServerModuleGraph({
  serverDirectoryUrl: new URL("./dist/server/", import.meta.url),
});

const runtime = createStartRuntime({
  clientDirectoryUrl: new URL("./dist/client/", import.meta.url),
  handler,
});

serveStartRuntime({ fetch: runtime.fetch, hostname: "0.0.0.0", port: 3000 });
```
