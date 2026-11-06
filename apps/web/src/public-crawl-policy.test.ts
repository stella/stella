import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { loadCatalogue } from "@stll/catalogue";

import {
  PUBLIC_CASE_LAW_PAGE_COUNTRIES,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import type { FileRouteTypes } from "@/routeTree.gen";

import {
  createPublicCrawlRules,
  isPublicCrawlPath,
  PUBLIC_CRAWL_ASSETS,
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
  test("published ownership proofs match their crawlable static assets", async () => {
    for (const { path } of PUBLIC_CRAWL_ASSETS) {
      const key = await Bun.file(
        nodePath.join(import.meta.dir, "../public", path),
      ).text();
      expect(`${key.trim()}.txt`).toBe(path.slice(1));
      expect(isPublicCrawlPath(path, options)).toBe(true);
      expect(isPublicCrawlPath(`${path}/other`, options)).toBe(false);
      expect(
        isPublicCrawlPath(path, { ...options, publicLawCrawlAllowed: false }),
      ).toBe(false);
    }
  });
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

  test("opens the law pages of pages-public jurisdictions only", () => {
    const rules = createPublicCrawlRules(options).filter(
      ({ path }) => path === "/law" || path.startsWith("/law/"),
    );
    expect(rules).toEqual([
      { path: "/law", scope: "exact" },
      ...PUBLIC_CASE_LAW_PAGE_COUNTRIES.map(
        (country) =>
          ({
            path: `/law/${toCaseLawCountryParam(country)}`,
            scope: "subtree",
          }) as const,
      ),
      { path: "/law/cases", scope: "exact" },
    ]);
    // The pages-public corpus today, and what stays closed beside it.
    expect(isPublicCrawlPath("/law/cze/cases/nejvyssi-soud/x", options)).toBe(
      PUBLIC_CASE_LAW_PAGE_COUNTRIES.some((country) => country === "CZE"),
    );
    for (const country of ["svk", "usa", "gbr", "eu", "pol", "hun", "aut"]) {
      if (
        PUBLIC_CASE_LAW_PAGE_COUNTRIES.some(
          (open) => toCaseLawCountryParam(open) === country,
        )
      ) {
        continue;
      }
      expect(
        isPublicCrawlPath(`/law/${country}/cases/court/slug`, options),
      ).toBe(false);
    }
    // The case-law hub is open exactly; other cross-country pages are not.
    expect(isPublicCrawlPath("/law/cases", options)).toBe(true);
    expect(isPublicCrawlPath("/law/cases/research", options)).toBe(false);
    expect(isPublicCrawlPath("/law/coverage", options)).toBe(false);
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
        ...loadCatalogue().map(
          ({ slug }) =>
            ({
              path: `${toolsBasePath}/${slug}`,
              scope: "exact",
            }) as const,
        ),
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
