import { loadCatalogue } from "@stll/catalogue";

import {
  PUBLIC_CASE_LAW_PAGE_COUNTRIES,
  toCaseLawCountryParam,
} from "./features/case-law/case-law-jurisdiction";

type PublicCrawlRoute = {
  path: `/${string}`;
  route: `/${string}`;
  /**
   * `jurisdictions`: the path itself, plus a subtree per jurisdiction whose
   * pages are public. A country whose pages are not public stays outside the
   * crawl, whatever it may serve.
   */
  scope: "exact" | "subtree" | "catalogue" | "jurisdictions";
  permission: "law" | "tools" | "knowledge";
  format: "html" | "xml";
};

export const PUBLIC_CRAWL_ROUTES = [
  {
    path: "/law",
    route: "/law",
    scope: "jurisdictions",
    permission: "law",
    format: "html",
  },
  // The case-law hub lists the admitted jurisdictions' decisions; its
  // search URLs stay behind Disallow: / as everything else does.
  {
    path: "/law/cases",
    route: "/law/cases/",
    scope: "exact",
    permission: "law",
    format: "html",
  },
  {
    path: "/sitemap.xml",
    route: "/sitemap.xml",
    scope: "exact",
    permission: "law",
    format: "xml",
  },
  {
    path: "/sitemaps",
    route: "/sitemaps/law.xml",
    scope: "subtree",
    permission: "law",
    format: "xml",
  },
  {
    path: "/tools",
    route: "/tools",
    scope: "catalogue",
    permission: "tools",
    format: "html",
  },
  {
    path: "/knowledge/tools",
    route: "/knowledge/tools",
    scope: "catalogue",
    permission: "tools",
    format: "html",
  },
  {
    path: "/knowledge/templates/catalogue",
    route: "/knowledge/templates/catalogue",
    scope: "subtree",
    permission: "knowledge",
    format: "html",
  },
] as const satisfies readonly PublicCrawlRoute[];

/** Static ownership proofs are served from public/, outside the route tree. */
export const PUBLIC_CRAWL_ASSETS = [
  {
    path: "/71e354a4429c5f0276819d8258136a50.txt",
    scope: "exact",
    permission: "law",
  },
] as const satisfies readonly Omit<PublicCrawlRoute, "route" | "format">[];

export type PublicCrawlOptions = {
  publicKnowledgeCrawlAllowed: boolean;
  publicLawCrawlAllowed: boolean;
  publicToolsCrawlAllowed: boolean;
  toolsBasePath: "/tools" | "/knowledge/tools";
};

export type PublicCrawlRule = {
  path: `/${string}`;
  scope: "exact" | "subtree";
};

/** The pages-public jurisdictions' law subtrees, read from the capability state. */
const publicLawJurisdictionCrawlPaths = (): readonly `/${string}`[] =>
  PUBLIC_CASE_LAW_PAGE_COUNTRIES.map(
    (country): `/${string}` => `/law/${toCaseLawCountryParam(country)}`,
  );

export const publicToolCrawlPaths = (
  toolsBasePath: PublicCrawlOptions["toolsBasePath"],
): readonly `/${string}`[] => [
  toolsBasePath,
  `${toolsBasePath}/contribute`,
  ...loadCatalogue().map(
    ({ slug }): `/${string}` => `${toolsBasePath}/${slug}`,
  ),
];

export const createPublicCrawlRules = ({
  publicKnowledgeCrawlAllowed,
  publicLawCrawlAllowed,
  publicToolsCrawlAllowed,
  toolsBasePath,
}: PublicCrawlOptions): readonly PublicCrawlRule[] => {
  const permissions = {
    law: publicLawCrawlAllowed,
    tools: publicToolsCrawlAllowed,
    knowledge: publicKnowledgeCrawlAllowed,
  } satisfies Record<PublicCrawlRoute["permission"], boolean>;
  const rules: PublicCrawlRule[] = [];
  for (const entry of [...PUBLIC_CRAWL_ROUTES, ...PUBLIC_CRAWL_ASSETS]) {
    if (!permissions[entry.permission]) {
      continue;
    }
    if (entry.scope === "jurisdictions") {
      rules.push({ path: entry.path, scope: "exact" });
      for (const path of publicLawJurisdictionCrawlPaths()) {
        rules.push({ path, scope: "subtree" });
      }
      continue;
    }
    if (entry.scope === "catalogue") {
      if (entry.path === toolsBasePath) {
        for (const path of publicToolCrawlPaths(toolsBasePath)) {
          rules.push({ path, scope: "exact" });
        }
      }
      continue;
    }
    rules.push({ path: entry.path, scope: entry.scope });
  }
  return rules;
};

export const isPublicCrawlPath = (
  path: string,
  options: PublicCrawlOptions,
): boolean =>
  createPublicCrawlRules(options).some(
    (rule) =>
      path === rule.path ||
      (rule.scope === "subtree" && path.startsWith(`${rule.path}/`)),
  );

/**
 * The one owner of "may a crawler index this law page": robots.txt, the law
 * sitemap and each page's meta robots all ask this, so a page is listed and
 * `index,follow` exactly when robots.txt allows it.
 */
export const isPublicLawPathIndexable = (
  path: string,
  publicLawCrawlAllowed: boolean,
): boolean =>
  isPublicCrawlPath(path, {
    publicKnowledgeCrawlAllowed: false,
    publicLawCrawlAllowed,
    publicToolsCrawlAllowed: false,
    toolsBasePath: "/tools",
  });
