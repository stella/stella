import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import {
  type Node,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";

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
  "apps/api/src/lib/case-law/decision-badges.ts": "pages",
  "apps/api/src/lib/case-law/language-alternates.ts": "pages",
  "apps/api/src/handlers/legislation/by-slug.ts": "pages",
  "apps/web/src/routes/law/-case-detail.logic.ts": "pages",
  "apps/web/src/components/chat/case-law-open.ts": "pages",
  "apps/web/src/components/chat/chat-decision-citation.tsx": "pages",
  "apps/web/src/features/statutes/statute-route-resolution.ts": "pages",
  "apps/web/src/features/statutes/components/pending-statute-changes.logic.ts":
    "pages",
  // The iOS app opens decisions as the web's decision pages do.
  "apps/mobile/src/state/case-law.ts": "pages",
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
  "apps/api/src/handlers/case-law/decisions/filter-validation.ts": "search",
  "apps/api/src/lib/case-law/filter-country-scope.ts": "search",
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
  "apps/api/src/lib/observability/data-invariants/catalog.ts": "search",
  "apps/web/src/lib/case-law-route.ts": "search",
  "apps/web/src/routes/law/index.tsx": "search",
  "apps/web/src/routes/law/cases/index.tsx": "search",
  "apps/web/src/routes/law/$country/statutes/index.tsx": "search",
  "apps/web/src/routes/law/-law-home/jurisdictions.ts": "search",
  "apps/web/src/features/case-law/components/top-bar-country.tsx": "search",
  "apps/web/src/features/chat/hooks/use-global-chat-mention-registration.ts":
    "search",
  // Tests and query-plan fixtures that mirror a surface's country filter.
  "apps/api/src/tests/query-plans/old-sitemap-refresh-fixture.ts": "sitemap",
  "apps/api/src/tests/query-plans/registry.ts": "search",
  "apps/api/src/tests/security/public-law-search-census.ts": "search",
  // Facet snapshots feed search facets.
  "apps/api/src/lib/legal-search/legislation-facet-refresh.ts": "search",
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
  "apps/api/src/lib/legal-search/legislation-redistribution.ts",
  // The decision gate page routes and agent tools share: each caller names
  // the surface it reads for.
  "apps/api/src/lib/case-law/public-subject.ts",
] as const;

/**
 * Callers of the SQL helpers that embed a country list, with the surface each
 * must pass. A helper takes the surface as an argument, so a caller cannot
 * read a list without naming it.
 */
const SQL_HELPER_CALLERS = {
  // Page reads and the SQL behind sitemaps.
  "apps/api/src/handlers/legislation/by-slug.ts": "pages",
  "apps/api/src/handlers/legislation/provision-preview.ts": "pages",
  "apps/api/src/lib/legal-search/statute-sitemap-shard-sql.ts": "pages",
  // Search, listing, facets, agent and reader surfaces.
  "apps/api/src/handlers/legislation/search.ts": "search",
  "apps/api/src/handlers/legislation/list.ts": "search",
  "apps/api/src/handlers/legislation/shelf.ts": "search",
  "apps/api/src/handlers/legislation/facets.ts": "search",
  "apps/api/src/handlers/chat/chat-prompt.ts": "search",
  "apps/api/src/handlers/legal-reader/annotations/document-blocks.ts": "search",
  "apps/api/src/handlers/legislation/resolve.ts": "search",
  "apps/api/src/lib/legal-search/legislation-work-names.ts": "search",
  "apps/api/src/lib/legal-search/legislation-facet-refresh.ts": "search",
  "apps/api/src/mcp/legislation-tools.ts": "search",
} as const satisfies Record<string, "pages" | "search">;

/**
 * Files that define the helpers, or reads built on them that page routes and
 * agent tools share: they take the surface as a parameter, and each caller
 * names its own.
 */
const SQL_HELPER_DEFINERS = [
  "apps/api/src/lib/legal-search/legislation-redistribution.ts",
  "apps/api/src/lib/legal-search/legislation-version-blocks.ts",
  "apps/api/src/handlers/legislation/by-eli.ts",
  "apps/api/src/handlers/legislation/get.ts",
  "apps/api/src/handlers/legislation/work-key.ts",
  "apps/api/src/handlers/legislation/provision-versions.ts",
  "apps/api/src/handlers/legislation/provision-history.ts",
  "apps/api/src/handlers/case-law/provisions/previews-for-decision.ts",
  // Resolves against the country list its caller's surface resolved to.
  "apps/api/src/lib/legal-search/legislation-works-at-date.ts",
] as const;

const SQL_HELPER_NAME =
  /\b(?:publishedLegislation\w*(?:For|In)|legislationCountriesFor|redistributableLegislationVersionFor|readVersionBlocks|readVersionText|readVersionAst|readStoredVersionAst|readBlocks)\(/gu;

/** The balanced argument text of every call to a country-list SQL helper. */
const helperCalls = (source: string): string[] => {
  const calls: string[] = [];
  for (const match of source.matchAll(SQL_HELPER_NAME)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      const char = source[end];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      }
      end += 1;
    }
    calls.push(source.slice(start, end - 1));
  }
  return calls;
};

/** Null marks a helper reference whose domain cannot be statically verified. */
const countryReadDomains = (source: string): (string | null)[] => {
  const parsed = parseSource("country-reader.ts", source);
  const helperNames = new Set([
    "readPublicLawCountry",
    "publicLawCountryUnavailable",
  ]);
  const names = new Set(helperNames);
  const domains: (string | null)[] = [];
  for (const statement of parsed.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      !statement.source.value.endsWith("/public-law-country")
    ) {
      continue;
    }
    // Empty named clauses and bare imports both have no specifiers in ESTree.
    let prefix = source.slice(statement.start, statement.source.start);
    for (const comment of parsed.comments.toReversed()) {
      if (
        comment.start >= statement.start &&
        comment.end <= statement.source.start
      ) {
        prefix =
          prefix.slice(0, comment.start - statement.start) +
          prefix.slice(comment.end - statement.start);
      }
    }
    if (!prefix.includes("{")) {
      domains.push(null);
      continue;
    }
    for (const binding of statement.specifiers) {
      if (binding.type !== "ImportSpecifier") {
        continue;
      }
      const imported =
        binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value;
      if (helperNames.has(imported)) {
        names.add(binding.local.name);
      }
    }
  }
  walk(parsed.program, (node, ancestors) => {
    if (node.type === "ImportDeclaration") {
      return "skip-children";
    }
    if (node.type !== "Identifier" || !names.has(node.name)) {
      return undefined;
    }
    if (ancestors.at(-1)?.type === "TSTypeQuery") {
      return undefined;
    }
    let expression: Node = node;
    let parentIndex = ancestors.length - 1;
    let parent = ancestors.at(parentIndex);
    while (
      parent?.type === "ParenthesizedExpression" ||
      (parent?.type === "LogicalExpression" && parent.operator === "??")
    ) {
      expression = parent;
      parentIndex -= 1;
      parent = parentIndex >= 0 ? ancestors.at(parentIndex) : undefined;
    }
    if (parent?.type !== "CallExpression" || parent.callee !== expression) {
      domains.push(null);
      return undefined;
    }
    const options = parent.arguments.at(1);
    if (
      options?.type !== "ObjectExpression" ||
      options.properties.some((property) => property.type === "SpreadElement")
    ) {
      domains.push(null);
      return undefined;
    }
    const domain = options.properties.filter(
      (property) =>
        property.type === "Property" &&
        !property.computed &&
        ((property.key.type === "Identifier" &&
          property.key.name === "domain") ||
          (property.key.type === "Literal" && property.key.value === "domain")),
    );
    const property = domain.at(0);
    domains.push(
      domain.length === 1 &&
        property?.type === "Property" &&
        property.kind === "init" &&
        !property.method &&
        !property.shorthand &&
        property.value.type === "Literal" &&
        typeof property.value.value === "string"
        ? property.value.value
        : null,
    );
    return undefined;
  });
  return domains;
};

const repoRoot = nodePath.resolve(import.meta.dir, "..");
const readSource = async (path: string) =>
  await Bun.file(nodePath.resolve(repoRoot, path)).text();

const mentionsAny = (source: string, tokens: readonly string[]) =>
  tokens.some((token) => source.includes(token));

describe("public law surface consumers", () => {
  test("each domain derives both serving lists from its own capability", async () => {
    const owners = {
      "packages/api-contract/src/case-law-launch-readiness.ts": "caseLaw",
      "packages/api-contract/src/legislation-publication.ts": "legislation",
    } as const;
    for (const [path, domain] of Object.entries(owners)) {
      const source = await readSource(path);
      const reads = [
        ...source.matchAll(
          /publicCountriesFor\(\s*"(caseLaw|legislation)",\s*"(pages|search)",?\s*\)/gu,
        ),
      ].map((match) => [match[1], match[2]]);
      expect(reads).toHaveLength(2);
      expect(reads).toEqual(
        expect.arrayContaining([
          [domain, "pages"],
          [domain, "search"],
        ]),
      );
    }
  });

  test("country-read detection includes nested inputs and imported aliases", () => {
    const source = `
      import { readPublicLawCountry as read, publicLawCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
      read(
        normalize(input, { locale: choose("en", "cs") }),
        { domain: 'legislation', surface: "search" }
      );
      publicLawCountryUnavailable
        (choose(input, "fallback"),
        { surface: "pages", domain: "caseLaw" });
    `;
    expect(countryReadDomains(source)).toEqual(["legislation", "caseLaw"]);
    expect(
      countryReadDomains(
        `(injected ?? publicLawCountryUnavailable)(input, { domain: "legislation" }); type Reader = typeof publicLawCountryUnavailable;`,
      ),
    ).toEqual(["legislation"]);
    expect(
      countryReadDomains(
        source.replace("domain: 'legislation'", "domain: 'caseLaw'"),
      ),
    ).toEqual(["caseLaw", "caseLaw"]);
  });

  test("unverifiable country-read references fail closed", () => {
    expect(
      countryReadDomains(`
      const indirect = readPublicLawCountry;
      indirect(input, options);
      publicLawCountryUnavailable(input, { ...options, domain: "caseLaw" });
      readPublicLawCountry(input, { domain: selectedDomain });
    `),
    ).toEqual([null, null, null]);
    expect(
      countryReadDomains(
        'import * as country from "@/api/lib/legal-search/public-law-country";',
      ),
    ).toEqual([null]);
  });

  test("country reads preserve import-clause and static-key distinctions", () => {
    for (const bindings of ["{}", "defaultReader, {}", "/* { */ {} /* } */"]) {
      expect(
        countryReadDomains(`import ${bindings} from "./public-law-country";`),
      ).toEqual([]);
    }
    for (const clause of [
      "",
      "defaultReader from ",
      "/* { */ * as readers from ",
    ]) {
      expect(
        countryReadDomains(`import ${clause}"./public-law-country";`),
      ).toEqual([null]);
    }
    expect(
      countryReadDomains(
        'readPublicLawCountry(input, { ["domain"]: "caseLaw" });',
      ),
    ).toEqual([null]);
  });

  test("every HTTP country read chooses its owning domain", async () => {
    const glob = new Bun.Glob(
      "apps/api/src/handlers/{case-law,legislation}/**/*.ts",
    );
    for await (const path of glob.scan({ cwd: repoRoot })) {
      if (/\.(test|spec)\.ts$/u.test(path)) {
        continue;
      }
      const source = await readSource(path);
      const domain = path.includes("/legislation/") ? "legislation" : "caseLaw";
      for (const detected of countryReadDomains(source)) {
        expect({ path, domain: detected }).toEqual({ path, domain });
      }
    }
  });

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

  test.each(Object.entries(SQL_HELPER_CALLERS))(
    "%s passes its surface (%s) at every country-list SQL helper call",
    async (path, surface) => {
      const calls = helperCalls(await readSource(path));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const literals = [...call.matchAll(/"(pages|search)"/gu)].map(
          (literal) => literal[1],
        );
        expect({ call: call.slice(0, 80), literals }).toEqual({
          call: call.slice(0, 80),
          literals: [surface],
        });
      }
    },
  );

  test("the helper matcher reads the surface and country-list forms alike", () => {
    expect(
      helperCalls(
        'a(publishedLegislationDocumentFor("pages")); b(publishedLegislationDocumentIn(countries)); c(legislationCountriesFor("search"));',
      ),
    ).toEqual(['"pages"', "countries", '"search"']);
  });

  test("no unregistered source file calls a country-list SQL helper", async () => {
    const registered = new Set<string>([
      ...Object.keys(SQL_HELPER_CALLERS),
      ...SQL_HELPER_DEFINERS,
    ]);
    const glob = new Bun.Glob("apps/*/src/**/*.{ts,tsx}");
    const unregistered: string[] = [];
    for await (const path of glob.scan({ cwd: repoRoot })) {
      if (
        path.includes("node_modules") ||
        /\.(test|spec|fixtures?|gen|d)\.tsx?$/u.test(path) ||
        registered.has(path)
      ) {
        continue;
      }
      if (helperCalls(await readSource(path)).length > 0) {
        unregistered.push(path);
      }
    }
    expect(unregistered).toEqual([]);
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
        mentionsAny(source, PAGES_LIST_TOKENS) ||
        source.includes("publicCountriesFor")
      ) {
        unregistered.push(path);
      }
    }
    expect(unregistered).toEqual([]);
  });
});
