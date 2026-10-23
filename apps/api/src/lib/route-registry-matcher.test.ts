import { expect, test } from "bun:test";
import { Elysia } from "elysia";

import { createRouteRegistryMatcher } from "./route-registry-matcher";

test("matching returns original mounted route identities without dispatching their handlers", () => {
  for (const aot of [true, false]) {
    let dispatched = 0;
    const handler = () => {
      dispatched += 1;
      return "fixture";
    };
    const app = new Elysia({ aot })
      .get("/fixed", handler)
      .get("/items/:id", handler)
      .all("/fallback/*", handler);
    const match = createRouteRegistryMatcher({
      routes: app.routes,
      staticRoutes: app.router.static,
      strictPath: app.config.strictPath,
      aot: app.config.aot,
    });
    const paths = ["/fixed", "/items/123", "/fallback/nested/path"];
    expect(paths).toHaveLength(app.routes.length);
    for (const [index, route] of app.routes.entries()) {
      const pathname = paths.at(index);
      expect(pathname).toBeDefined();
      const request = new Request(`http://localhost${pathname}`, {
        method: route.method === "ALL" ? "DELETE" : route.method,
      });
      expect(match(request)).toBe(route);
    }
    expect(match(new Request("http://localhost/missing"))).toBeUndefined();
    expect(dispatched).toBe(0);
  }
});
