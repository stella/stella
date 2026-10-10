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
