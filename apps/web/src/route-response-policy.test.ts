import { expect, test } from "bun:test";

import { isPublicCrawlPath } from "@/public-crawl-policy";
import type { PublicCrawlOptions } from "@/public-crawl-policy";
import type { CacheClass } from "@/route-response-policy";
import {
  ANONYMOUS_DOCUMENT_CACHE_CONTROL,
  CACHE_CLASS_POLICIES,
  documentResponsePolicyHeaders,
  PRIVATE_CACHE_CONTROL,
  responseCachePolicy,
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

const documentCacheControl = (
  cacheClass: CacheClass,
  {
    isAnonymous = true,
    status = 200,
    setsCookie = false,
  }: { isAnonymous?: boolean; status?: number; setsCookie?: boolean } = {},
) =>
  responseCachePolicy({
    cacheClass,
    status,
    isHtml: true,
    isAnonymous,
    setsCookie,
    routeCacheControl: null,
  }).cacheControl;

test("public law documents may be shared only when rendered for an anonymous request", () => {
  // Every public law reading page, and only those, is a public document.
  const lawDocuments = Object.entries(ROUTE_CACHE_CLASSES).flatMap(
    ([fullPath, cacheClass]) =>
      fullPath.startsWith("/law/") && cacheClass === "public-indexable"
        ? [[fullPath, cacheClass] as const]
        : [],
  );
  expect(ROUTE_CACHE_CLASSES["/law/$country/statutes/$slug/"]).toBe(
    "public-indexable",
  );
  expect(ROUTE_CACHE_CLASSES["/law/$country/cases/$court/$slug"]).toBe(
    "public-indexable",
  );
  expect(ROUTE_CACHE_CLASSES["/law/cases/research/$tableId"]).toBe(
    "private-no-store",
  );
  expect(lawDocuments.length).toBeGreaterThan(5);
  for (const [fullPath, cacheClass] of lawDocuments) {
    expect(documentCacheControl(cacheClass), fullPath).toBe(
      ANONYMOUS_DOCUMENT_CACHE_CONTROL,
    );
    expect(documentCacheControl(cacheClass, { isAnonymous: false })).toBe(
      PRIVATE_CACHE_CONTROL,
    );
    expect(documentCacheControl(cacheClass, { setsCookie: true })).toBe(
      PRIVATE_CACHE_CONTROL,
    );
    for (const status of [301, 404, 500, 502, 503, 504]) {
      expect(documentCacheControl(cacheClass, { status })).toBe(
        PRIVATE_CACHE_CONTROL,
      );
    }
  }
});

test("signed-in and app documents are never shared", () => {
  for (const [fullPath, cacheClass] of Object.entries(ROUTE_CACHE_CLASSES)) {
    if (cacheClass !== "private-no-store") {
      continue;
    }
    for (const isAnonymous of [true, false]) {
      expect(
        responseCachePolicy({
          cacheClass,
          status: 200,
          isHtml: true,
          isAnonymous,
          setsCookie: false,
          routeCacheControl: "public, max-age=300",
        }),
        fullPath,
      ).toEqual({
        cacheControl: PRIVATE_CACHE_CONTROL,
        shared: false,
        vary: null,
        indexable: false,
      });
    }
  }
  expect(
    responseCachePolicy({
      cacheClass: null,
      status: 200,
      isHtml: true,
      isAnonymous: true,
      setsCookie: false,
      routeCacheControl: "public, max-age=300",
    }).cacheControl,
  ).toBe(PRIVATE_CACHE_CONTROL);
});

test("each cache class states its shared-cache policy", () => {
  const sharedAt = Object.fromEntries(
    Object.entries(CACHE_CLASS_POLICIES).map(([cacheClass, policy]) => [
      cacheClass,
      policy.sharedCache,
    ]),
  );
  expect(sharedAt).toEqual({
    "private-no-store": "never",
    "public-anonymous": "origin-policy",
    "public-indexable": "anonymous-document",
  });
});
