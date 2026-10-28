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
import path from "node:path";

import { assertSsrDocument } from "@stll/ssr-testkit";

import { createRootHead } from "./-root-head";

Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
});
const { createPublicHead } = await import("@/lib/public-seo");

/** `#rgb` as `#rrggbb`, lower-cased, so equal colours compare equal. */
const fullHex = (hex: string) =>
  hex.replace(/^#(\w)(\w)(\w)$/u, "#$1$1$2$2$3$3").toLowerCase();

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

  test("lets the app reach the screen edges without blocking zoom", () => {
    const viewport = createRootHead(false).meta.find(
      (meta) => "name" in meta && meta.name === "viewport",
    );
    const content =
      viewport !== undefined && "content" in viewport ? viewport.content : "";

    expect(content).toContain("viewport-fit=cover");
    // Pinch zoom is an accessibility feature; the app never turns it off.
    expect(content).not.toMatch(/user-scalable|maximum-scale/u);
  });

  test("colours the browser chrome for both colour schemes", () => {
    const media = createRootHead(false).meta.flatMap((meta) =>
      "name" in meta && meta.name === "theme-color" && "media" in meta
        ? [meta.media]
        : [],
    );

    expect(media.toSorted()).toEqual([
      "(prefers-color-scheme: dark)",
      "(prefers-color-scheme: light)",
    ]);
  });

  // The meta tag cannot read a CSS variable, so it carries the theme's
  // resolved `--background` literally. The mobile theme generator resolves
  // theme.css to sRGB and CI keeps its output current; the two must agree.
  test("colours the browser chrome with the theme's resolved background", async () => {
    const generated = await Bun.file(
      path.resolve(import.meta.dir, "../../../mobile/src/ui-theme.gen.ts"),
    ).text();
    const themeBackground = (scheme: "light" | "dark") =>
      fullHex(
        new RegExp(`${scheme}: \\{[^}]*?background: "(#[0-9a-f]+)"`, "u").exec(
          generated,
        )?.[1] ?? "",
      );
    const metaContent = (scheme: "light" | "dark") => {
      const meta = createRootHead(false).meta.find(
        (entry) =>
          "media" in entry &&
          entry.media === `(prefers-color-scheme: ${scheme})`,
      );
      return fullHex(
        meta !== undefined && "content" in meta ? meta.content : "",
      );
    };

    expect(themeBackground("light")).toMatch(/^#[0-9a-f]{6}$/u);
    expect(metaContent("light")).toBe(themeBackground("light"));
    expect(themeBackground("dark")).toMatch(/^#[0-9a-f]{6}$/u);
    expect(metaContent("dark")).toBe(themeBackground("dark"));
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
