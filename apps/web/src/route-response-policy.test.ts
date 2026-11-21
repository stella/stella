import { expect, test } from "bun:test";

import { isPublicCrawlPath } from "@/public-crawl-policy";
import type { PublicCrawlOptions } from "@/public-crawl-policy";
import {
  documentResponsePolicyHeaders,
  ROUTE_CACHE_CLASSES,
  SSR_CACHE_CLASS_HEADER,
} from "@/route-response-policy";

const crawl = {
  publicKnowledgeCrawlAllowed: true,
  publicLawCrawlAllowed: true,
  publicToolsCrawlAllowed: true,
  toolsBasePath: "/tools",
} as const satisfies PublicCrawlOptions;

test("each declared route applies its document policy", () => {
  for (const [fullPath, cacheClass] of Object.entries(ROUTE_CACHE_CLASSES)) {
    const pathname = fullPath.replace(/\/$/u, "");
    const headers = documentResponsePolicyHeaders({
      match: { fullPath, pathname, status: "success", ssr: true },
      crawl,
    });
    expect(headers[SSR_CACHE_CLASS_HEADER]).toBe(
      cacheClass === "public-indexable" && isPublicCrawlPath(pathname, crawl)
        ? "public-indexable"
        : "private-no-store",
    );
    for (const status of ["pending", "error", "notFound"]) {
      expect(
        documentResponsePolicyHeaders({
          match: { fullPath, pathname, status, ssr: true },
          crawl,
        })[SSR_CACHE_CLASS_HEADER],
      ).toBe("private-no-store");
    }
    expect(
      documentResponsePolicyHeaders({
        match: { fullPath, pathname, status: "success", ssr: false },
        crawl,
      })[SSR_CACHE_CLASS_HEADER],
    ).toBe("private-no-store");
  }
  expect(
    documentResponsePolicyHeaders({ match: undefined, crawl })[
      SSR_CACHE_CLASS_HEADER
    ],
  ).toBe("private-no-store");
});

test("published catalogue documents require indexing permission", () => {
  for (const publicToolsCrawlAllowed of [false, true]) {
    for (const [pathname, fullPath] of [
      ["/tools", "/tools/"],
      ["/tools/contract-review-anthropic", "/tools/$slug"],
      ["/tools/contribute", "/tools/contribute"],
    ] as const) {
      expect(
        documentResponsePolicyHeaders({
          match: { fullPath, pathname, status: "success", ssr: true },
          crawl: { ...crawl, publicToolsCrawlAllowed },
        })[SSR_CACHE_CLASS_HEADER],
      ).toBe(publicToolsCrawlAllowed ? "public-indexable" : "private-no-store");
    }
  }
});

test("an organization's Knowledge pages stay private beside their public catalogues", () => {
  const knowledgeCrawl = {
    ...crawl,
    toolsBasePath: "/knowledge/tools",
  } as const;
  const cases = [
    ["/knowledge/templates", "/knowledge/templates", "private-no-store"],
    ["/knowledge/playbooks", "/knowledge/playbooks", "private-no-store"],
    ["/knowledge/tools", "/knowledge/tools", "private-no-store"],
    [
      "/knowledge/tools/skills/$skillId",
      "/knowledge/tools/skills/11111111-1111-4111-8111-111111111111",
      "private-no-store",
    ],
    [
      "/knowledge/templates/catalogue/",
      "/knowledge/templates/catalogue",
      "public-indexable",
    ],
    [
      "/knowledge/playbooks/catalogue",
      "/knowledge/playbooks/catalogue",
      "public-indexable",
    ],
    [
      "/knowledge/tools/catalogue",
      "/knowledge/tools/catalogue",
      "public-indexable",
    ],
    ["/knowledge/tools/$entry", "/knowledge/tools/ares", "public-indexable"],
  ] as const satisfies readonly (readonly [
    keyof typeof ROUTE_CACHE_CLASSES,
    string,
    string,
  ])[];
  for (const [fullPath, pathname, expected] of cases) {
    expect(ROUTE_CACHE_CLASSES[fullPath]).toBe(expected);
    expect(
      documentResponsePolicyHeaders({
        match: { fullPath, pathname, status: "success", ssr: true },
        crawl: knowledgeCrawl,
      })[SSR_CACHE_CLASS_HEADER],
    ).toBe(expected);
  }
});

test("handoff confirmation always uses a private document with no referrer", () => {
  for (const status of ["success", "pending", "error"]) {
    expect(
      documentResponsePolicyHeaders({
        match: {
          fullPath: "/auth/handoff",
          pathname: "/auth/handoff",
          status,
          ssr: false,
        },
        crawl,
      }),
    ).toEqual({
      [SSR_CACHE_CLASS_HEADER]: "private-no-store",
      "Referrer-Policy": "no-referrer",
    });
  }
});
