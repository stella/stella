import { loadCatalogue } from "@stll/catalogue";

type PublicCrawlRoute = {
  path: `/${string}`;
  route: `/${string}`;
  scope: "exact" | "subtree" | "catalogue";
  permission: "law" | "tools" | "knowledge";
};

export const PUBLIC_CRAWL_ROUTES = [
  { path: "/law", route: "/law", scope: "subtree", permission: "law" },
  {
    path: "/sitemap.xml",
    route: "/sitemap.xml",
    scope: "exact",
    permission: "law",
  },
  {
    path: "/sitemaps",
    route: "/sitemaps/law.xml",
    scope: "subtree",
    permission: "law",
  },
  { path: "/tools", route: "/tools", scope: "catalogue", permission: "tools" },
  {
    path: "/knowledge/tools",
    route: "/knowledge/tools",
    scope: "catalogue",
    permission: "tools",
  },
  {
    path: "/knowledge/templates/catalogue",
    route: "/knowledge/templates/catalogue",
    scope: "subtree",
    permission: "knowledge",
  },
] as const satisfies readonly PublicCrawlRoute[];

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
  for (const entry of PUBLIC_CRAWL_ROUTES) {
    if (!permissions[entry.permission]) {
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
