import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  HeadContent,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, test } from "bun:test";

import { assertSsrDocument } from "@stll/ssr-testkit";

import { createRootHead } from "./-root-head";

Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
});
const { createPublicHead } = await import("@/lib/public-seo");

describe("root document feature marker", () => {
  test("emits the public knowledge marker only with the flag enabled", () => {
    expect(createRootHead(true).meta).toContainEqual({
      name: "public-knowledge",
      content: "enabled",
    });
    expect(
      createRootHead(false).meta.some(
        (meta) => "name" in meta && meta.name === "public-knowledge",
      ),
    ).toBe(false);
  });

  test("supplies default robots metadata for each feature state", () => {
    for (const enabled of [false, true]) {
      expect(createRootHead(enabled).meta).toContainEqual({
        name: "robots",
        content: "noindex,nofollow",
      });
    }
  });

  test("uses the most specific page robots metadata", async () => {
    for (const crawlAllowed of [false, true]) {
      const rootRoute = createRootRoute({
        head: () => createRootHead(false),
        component: HeadContent,
      });
      const pageRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        head: () =>
          createPublicHead({
            crawlAllowed,
            path: "/law",
            title: "Catalogue",
            type: "website",
          }),
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([pageRoute]),
        history: createMemoryHistory({ initialEntries: ["/"] }),
        isServer: true,
      });
      await router.load();
      const html = renderToString(createElement(RouterProvider, { router }));
      assertSsrDocument({
        html,
        status: 200,
        contentType: "text/html",
        requiredContent: [
          crawlAllowed
            ? 'name="robots" content="index,follow,'
            : 'name="robots" content="noindex,nofollow"',
        ],
        forbiddenContent: crawlAllowed ? ["noindex"] : [],
      });
      expect(html.match(/name="robots"/gu)).toHaveLength(1);
    }
  });
});
