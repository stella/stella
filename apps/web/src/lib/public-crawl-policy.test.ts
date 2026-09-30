import { describe, expect, test } from "bun:test";

import { loadCatalogue } from "@stll/catalogue";

import type { FileRouteTypes } from "@/routeTree.gen";

import {
  createPublicCrawlRules,
  isPublicCrawlPath,
  PUBLIC_CRAWL_ROUTES,
  type PublicCrawlOptions,
} from "./public-crawl-policy";

const crawlRoutes = PUBLIC_CRAWL_ROUTES satisfies readonly {
  route: FileRouteTypes["fullPaths"];
}[];

const options = {
  publicKnowledgeCrawlAllowed: true,
  publicLawCrawlAllowed: true,
  publicToolsCrawlAllowed: true,
  toolsBasePath: "/knowledge/tools",
} as const satisfies PublicCrawlOptions;

describe("public crawl policy", () => {
  test("declares a route for each crawl surface", () => {
    expect(new Set(crawlRoutes.map(({ path }) => path)).size).toBe(
      crawlRoutes.length,
    );
    for (const { path, scope } of crawlRoutes) {
      if (scope === "catalogue" && path !== options.toolsBasePath) {
        continue;
      }
      expect(isPublicCrawlPath(path, options)).toBe(true);
    }
  });

  test("enumerates the published tool pages for both namespaces", () => {
    for (const toolsBasePath of ["/tools", "/knowledge/tools"] as const) {
      const enabled = { ...options, toolsBasePath };
      const rules = createPublicCrawlRules(enabled).filter(({ path }) =>
        path.startsWith(toolsBasePath),
      );
      expect(rules).toEqual([
        { path: toolsBasePath, scope: "exact" },
        { path: `${toolsBasePath}/contribute`, scope: "exact" },
        ...loadCatalogue().map(({ slug }) => ({
          path: `${toolsBasePath}/${slug}`,
          scope: "exact",
        })),
      ]);
      for (const { path } of rules) {
        expect(isPublicCrawlPath(path, enabled)).toBe(true);
        expect(isPublicCrawlPath(`${path}/download`, enabled)).toBe(false);
      }
    }
  });

  test("requires permission for each declared surface", () => {
    for (const publicKnowledgeCrawlAllowed of [false, true]) {
      for (const publicLawCrawlAllowed of [false, true]) {
        for (const publicToolsCrawlAllowed of [false, true]) {
          const enabled = {
            ...options,
            publicKnowledgeCrawlAllowed,
            publicLawCrawlAllowed,
            publicToolsCrawlAllowed,
          };
          const permissions = {
            knowledge: publicKnowledgeCrawlAllowed,
            law: publicLawCrawlAllowed,
            tools: publicToolsCrawlAllowed,
          };
          for (const entry of crawlRoutes) {
            if (
              entry.scope === "catalogue" &&
              entry.path !== options.toolsBasePath
            ) {
              continue;
            }
            expect(isPublicCrawlPath(entry.path, enabled)).toBe(
              permissions[entry.permission],
            );
          }
        }
      }
    }
  });
});
