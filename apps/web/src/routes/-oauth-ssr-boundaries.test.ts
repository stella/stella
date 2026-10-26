import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, test } from "bun:test";

import { Route as AuthRoute } from "@/routes/auth/route";
import { Route as ConsentRoute } from "@/routes/consent";

test("OAuth routes preserve server presentation and defer fragment-dependent work to the browser", async () => {
  const boundaries = [
    { path: "/auth", ssr: AuthRoute.options.ssr },
    { path: "/consent", ssr: ConsentRoute.options.ssr },
  ];

  for (const { path, ssr } of boundaries) {
    expect(ssr).toBe(false);
    if (ssr !== false) {
      throw new TypeError("OAuth boundary must defer to the browser");
    }
    const browserHash = "oauth_query=signed-request";
    const serverUrl = new URL(`http://localhost:3000${path}#${browserHash}`);
    const fragmentReads: string[] = [];
    for (const isServer of [true, false]) {
      const root = createRootRoute({
        beforeLoad: () => ({ renderedLocale: "cs" }),
      });
      const boundary = createRoute({
        getParentRoute: () => root,
        path,
        ssr,
        beforeLoad: ({ location }) => {
          fragmentReads.push(location.hash);
        },
      });
      const router = createRouter({
        origin: serverUrl.origin,
        routeTree: root.addChildren([boundary]),
        history: createMemoryHistory({
          // HTTP requests never contain the fragment; browser history does.
          initialEntries: [
            isServer
              ? serverUrl.pathname
              : `${serverUrl.pathname}${serverUrl.hash}`,
          ],
        }),
        isServer,
      });
      await router.load();
      expect(router.state.matches.at(-1)?.context).toMatchObject({
        renderedLocale: "cs",
      });
      expect(fragmentReads).toEqual(isServer ? [] : [browserHash]);
    }
  }
});
