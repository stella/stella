import { createServerOnlyFn } from "@tanstack/react-start";

import { loadCatalogue } from "@stll/catalogue";

import {
  PUBLIC_CASE_LAW_PAGE_COUNTRIES,
  toCaseLawCountryParam,
} from "./features/case-law/case-law-jurisdiction";
import { toolsCataloguePathOf } from "./lib/knowledge/public-tools-catalogue-path";
import type { PublicToolsBasePath } from "./lib/knowledge/public-tools-catalogue-path";

type PublicCrawlRoute = {
  path: `/${string}`;
  route: `/${string}`;
  /**
   * `catalogue`: the published tools' list, with their pages beside it, when
   * the tools live where this list does.
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
  // The published tools' list; `/knowledge/tools` is an organization's own
  // page and stays closed.
  {
    path: "/knowledge/tools/catalogue",
    route: "/knowledge/tools/catalogue",
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
  {
    path: "/knowledge/playbooks/catalogue",
    route: "/knowledge/playbooks/catalogue",
    scope: "exact",
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
  // The built scripts and styles: a crawler renders the public pages with
  // them, so a page it may index must not have its assets blocked.
  {
    path: "/assets",
    scope: "subtree",
    permission: "law",
  },
] as const satisfies readonly Omit<PublicCrawlRoute, "route" | "format">[];

export type PublicCrawlOptions = {
  publicKnowledgeCrawlAllowed: boolean;
  publicLawCrawlAllowed: boolean;
  publicToolsCrawlAllowed: boolean;
  toolsBasePath: PublicToolsBasePath;
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

/**
 * The catalogue's tool slugs. Only the server lists tool pages (robots.txt,
 * the tools sitemap and a document's cache headers); the browser asks only
 * about law pages, so the catalogue stays out of the startup bundle.
 */
const catalogueToolSlugs = createServerOnlyFn((): readonly string[] =>
  loadCatalogue().map(({ slug }) => slug),
);

export const publicToolCrawlPaths = (
  toolsBasePath: PublicCrawlOptions["toolsBasePath"],
): readonly `/${string}`[] => [
  toolsCataloguePathOf(toolsBasePath),
  `${toolsBasePath}/contribute`,
  ...catalogueToolSlugs().map(
    (slug): `/${string}` => `${toolsBasePath}/${slug}`,
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
      if (entry.path === toolsCataloguePathOf(toolsBasePath)) {
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

const CRAWL_URL_BASE = "https://crawl.invalid";

/**
 * Whether a URL carries a query delimiter before its fragment. A bare
 * trailing `?` leaves `URL.search` empty, yet robots.txt's `?` rule matches
 * it, so the delimiter itself decides.
 */
export const hasPublicLawQuery = (href: string): boolean =>
  (href.split("#", 1).at(0) ?? "").includes("?");

/**
 * The same answer for a whole URL a page is served at. A query string makes
 * any law page a search, filter or paging variant of a query-free page, so it
 * is never indexable: robots.txt blocks it (see `publicCrawlRobotsLines`) and
 * its head says `noindex`, pointing at the hub it varies.
 */
export const isPublicLawUrlIndexable = (
  href: string,
  publicLawCrawlAllowed: boolean,
): boolean => {
  const url = new URL(href, CRAWL_URL_BASE);
  return (
    !hasPublicLawQuery(href) &&
    isPublicLawPathIndexable(url.pathname, publicLawCrawlAllowed)
  );
};

/**
 * robots.txt's path rules for the rules `createPublicCrawlRules` built. A law
 * subtree allows its query-free URLs only: the `Disallow: <subtree>/*?` line
 * is longer than the subtree's `Allow`, so it wins under longest-match
 * precedence.
 */
export const publicCrawlRobotsLines = (
  rules: readonly PublicCrawlRule[],
): string[] =>
  rules.flatMap(({ path, scope }) => {
    if (scope === "exact") {
      return [`Allow: ${path}$`];
    }
    const queryRule = path.startsWith("/law/") ? [`Disallow: ${path}/*?`] : [];
    return [...queryRule, `Allow: ${path}/`, `Allow: ${path}$`];
  });
