import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, test } from "bun:test";

import { Route as AuthRoute } from "@/routes/auth/route";
import { Route as ConsentRoute } from "@/routes/consent";

const boundaries = [
  { path: "/auth", ssr: AuthRoute.options.ssr },
  { path: "/consent", ssr: ConsentRoute.options.ssr },
];

for (const { path, ssr } of boundaries) {
  test(`${path} preserves server presentation while fragment-dependent work waits for the browser`, async () => {
    const browserHash = "oauth_query=signed-request";
    const serverUrl = new URL(`http://localhost:3000${path}#${browserHash}`);
    const fragmentReads: string[] = [];
    for (const isServer of [true, false]) {
      const root = createRootRoute({
        ssr: true,
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
      expect(router.state.matches.at(-1)?.context.renderedLocale).toBe("cs");
      expect(fragmentReads).toEqual(isServer ? [] : [browserHash]);
    }
  });
}
