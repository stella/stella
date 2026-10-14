import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

/**
 * Every consumer of the public country lists names the surface it serves.
 *
 * Two lists exist: the countries whose pages are public (decision and statute
 * pages, sitemaps, crawl rules) and the countries admitted to search (search
 * handlers, MCP, chat). A consumer reads exactly one of them. A source file
 * that mentions either list and is not registered here fails, so a new
 * consumer cannot ship without choosing.
 */

type SurfaceCategory = "pages" | "sitemap" | "crawl" | "search" | "mcp";

const LIST_READ_BY_CATEGORY = {
  pages: "pages",
  sitemap: "pages",
  crawl: "pages",
  search: "search",
  mcp: "search",
} as const satisfies Record<SurfaceCategory, "pages" | "search">;

const SEARCH_LIST_TOKENS = [
  "PUBLIC_CASE_LAW_COUNTRIES",
  "PUBLIC_LEGISLATION_COUNTRIES",
  "ADMITTED_PUBLIC_COUNTRIES",
  "isPublicCaseLawCountry",
  "publicCaseLawCountryFromParam",
  "publicCaseLawCountry(",
  "isPublicStatuteCountry",
  "isPublicLegislationCountry",
  "publicLegislationCountry(",
];

const PAGES_LIST_TOKENS = [
  "PUBLIC_CASE_LAW_PAGE_COUNTRIES",
  "PUBLIC_LEGISLATION_PAGE_COUNTRIES",
  "PAGES_PUBLIC_COUNTRIES",
  "isPublicCaseLawPageCountry",
  "publicCaseLawPageCountryFromParam",
  "publicCaseLawPageCountry(",
  "isPublicStatutePageCountry",
  "isPublicLegislationPageCountry",
];

const SEARCH_SURFACE_LITERAL = /surface: "search"|, "search"\)/u;
const PAGES_SURFACE_LITERAL = /surface: "pages"|, "pages"\)/u;

const CONSUMERS = {
  // Decision and statute pages, and the API reads that serve them.
  "apps/api/src/handlers/case-law/public-routes.ts": "pages",
  "apps/api/src/lib/case-law/public-subject.ts": "pages",
  "apps/api/src/lib/case-law/decision-badges.ts": "pages",
  "apps/api/src/lib/case-law/language-alternates.ts": "pages",
  "apps/api/src/handlers/case-law/decisions/citation-graph.ts": "pages",
  "apps/api/src/handlers/legislation/by-slug.ts": "pages",
  "apps/web/src/routes/law/-case-detail.logic.ts": "pages",
  "apps/web/src/components/chat/case-law-open.ts": "pages",
  "apps/web/src/components/chat/chat-decision-citation.tsx": "pages",
  "apps/web/src/features/statutes/statute-route-resolution.ts": "pages",
  // Sitemaps.
  "apps/api/src/handlers/case-law/decisions/sitemap.ts": "sitemap",
  "apps/api/src/handlers/legislation/sitemap.ts": "sitemap",
  "apps/api/src/lib/case-law/sitemap-shard-refresh.ts": "sitemap",
  "apps/web/src/lib/public-law-sitemap.ts": "sitemap",
  "apps/web/src/features/statutes/statute-sitemap.ts": "sitemap",
  "apps/web/src/routes/sitemaps/law-cases/$country/$year/{$month}[.]xml.ts":
    "sitemap",
  "apps/web/src/routes/sitemaps/law-cases/$country/$year/$month/{$bucket}[.]xml.ts":
    "sitemap",
  "apps/web/src/routes/sitemaps/law-statutes/{$country}[.]xml.ts": "sitemap",
  "apps/web/src/routes/sitemaps/law-statutes/$country/{$bucket}[.]xml.ts":
    "sitemap",
  // Crawler rules.
  "apps/web/src/public-crawl-policy.ts": "crawl",
  // Search, listing and browse.
  "apps/api/src/handlers/case-law/decisions/list.ts": "search",
  "apps/api/src/handlers/case-law/decisions/search.ts": "search",
  "apps/api/src/handlers/case-law/decisions/search-expand.ts": "search",
  "apps/api/src/handlers/case-law/decisions/search-refine.ts": "search",
  "apps/api/src/handlers/case-law/decisions/latest.ts": "search",
  "apps/api/src/handlers/case-law/decisions/facets.ts": "search",
  "apps/api/src/handlers/case-law/decisions/status.ts": "search",
  "apps/api/src/handlers/case-law/decisions/coverage.ts": "search",
  "apps/api/src/handlers/case-law/provisions/citing-decisions.ts": "search",
  "apps/api/src/handlers/case-law/provisions/citation-counts.ts": "search",
  "apps/api/src/handlers/legislation/shelf.ts": "search",
  "apps/api/src/handlers/legislation/list.ts": "search",
  "apps/api/src/handlers/legislation/facets.ts": "search",
  "apps/api/src/handlers/legislation/public-search.ts": "search",
  "apps/api/src/handlers/legislation/resolve.ts": "search",
  "apps/api/src/handlers/legislation/search.ts": "search",
  "apps/api/src/handlers/legislation/search-schema.ts": "search",
  "apps/api/src/handlers/chat/chat-prompt.ts": "search",
  "apps/web/src/lib/case-law-route.ts": "search",
  "apps/web/src/routes/law/index.tsx": "search",
  "apps/web/src/routes/law/cases/index.tsx": "search",
  "apps/web/src/routes/law/$country/statutes/index.tsx": "search",
  "apps/web/src/routes/law/-law-home/jurisdictions.ts": "search",
  "apps/web/src/features/case-law/components/top-bar-country.tsx": "search",
  // Agent surfaces.
  "apps/api/src/mcp/stella-tools.ts": "mcp",
  "apps/api/src/mcp/legislation-tools.ts": "mcp",
  "apps/api/src/mcp/case-law-search-guidance.ts": "mcp",
  "apps/api/src/mcp/compat-corpus.ts": "mcp",
  "apps/api/src/mcp/compat-shared.ts": "mcp",
  "packages/mcp-apps/src/case-law-results/view.tsx": "mcp",
} as const satisfies Record<string, SurfaceCategory>;

/** Files that define both lists for their layer; they must expose both. */
const DEFINERS = [
  "apps/web/src/features/case-law/case-law-jurisdiction.ts",
  "apps/web/src/lib/statutes/statute-route.ts",
] as const;

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const readSource = async (path: string) =>
  await Bun.file(nodePath.resolve(repoRoot, path)).text();

const mentionsAny = (source: string, tokens: readonly string[]) =>
  tokens.some((token) => source.includes(token));

describe("public law surface consumers", () => {
  test.each(Object.entries(CONSUMERS))(
    "%s reads only the list of its category (%s)",
    async (path, category) => {
      const source = await readSource(path);
      const reads = LIST_READ_BY_CATEGORY[category];
      const own = reads === "pages" ? PAGES_LIST_TOKENS : SEARCH_LIST_TOKENS;
      const other = reads === "pages" ? SEARCH_LIST_TOKENS : PAGES_LIST_TOKENS;
      const ownLiteral =
        reads === "pages" ? PAGES_SURFACE_LITERAL : SEARCH_SURFACE_LITERAL;
      const otherLiteral =
        reads === "pages" ? SEARCH_SURFACE_LITERAL : PAGES_SURFACE_LITERAL;

      expect(mentionsAny(source, own) || ownLiteral.test(source)).toBe(true);
      expect(mentionsAny(source, other)).toBe(false);
      expect(otherLiteral.test(source)).toBe(false);
    },
  );

  test.each(DEFINERS)("%s defines both lists", async (path) => {
    const source = await readSource(path);
    expect(mentionsAny(source, SEARCH_LIST_TOKENS)).toBe(true);
    expect(mentionsAny(source, PAGES_LIST_TOKENS)).toBe(true);
  });

  test("no unregistered source file reads either list", async () => {
    const registered = new Set<string>([
      ...Object.keys(CONSUMERS),
      ...DEFINERS,
    ]);
    const glob = new Bun.Glob("{apps,packages}/*/src/**/*.{ts,tsx}");
    const unregistered: string[] = [];
    for await (const path of glob.scan({ cwd: repoRoot })) {
      if (
        path.includes("node_modules") ||
        path.includes("/generated/") ||
        path.startsWith("packages/api-contract/src/") ||
        /\.(test|spec|fixtures?|gen|d)\.tsx?$/u.test(path) ||
        registered.has(path)
      ) {
        continue;
      }
      const source = await readSource(path);
      if (
        mentionsAny(source, SEARCH_LIST_TOKENS) ||
        mentionsAny(source, PAGES_LIST_TOKENS)
      ) {
        unregistered.push(path);
      }
    }
    expect(unregistered).toEqual([]);
  });
});
