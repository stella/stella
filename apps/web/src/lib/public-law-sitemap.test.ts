import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { CASE_LAW_BROWSER_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import {
  PUBLIC_ROBOTS_ALLOWED_SEARCH_USER_AGENTS,
  PUBLIC_ROBOTS_DENIED_USER_AGENTS,
} from "@stll/api-contract/public-crawl-rules";
import { rejectionOf } from "@stll/property-testing/rejection";

// Type-only, so the decision reader's component graph never loads here.
import {
  PUBLIC_CASE_LAW_PAGE_COUNTRIES,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import type { DecisionWorkspaceProps } from "@/features/case-law/components/case-viewer/decision-workspace";
import {
  isPublicLawPathIndexable,
  publicToolCrawlPaths,
} from "@/public-crawl-policy";

/** Whether an AI-mode branch carries the authenticated availability gate. */
type CarriesAvailabilityGate<TMode> = "ensureAIAvailable" extends keyof TMode
  ? true
  : false;

Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
});

const {
  assertPublicLawSitemapXmlWithinProtocolLimits,
  createPublicCaseLawSitemapXml,
  createPublicLawStaticSitemapXml,
  createPublicLawSitemapIndexXml,
  createRobotsTxt,
  fetchPublicSitemapDecisions,
  fetchPublicSitemapShards,
  SITEMAP_XML_RESPONSE_HEADERS,
} = await import("@/lib/public-law-sitemap");
const {
  createSitemapReadFailureResponse,
  createSitemapUpstreamBusyError,
  SitemapUpstreamBusyError,
} = await import("@/lib/public-sitemap");
const { isPublicSsrPath } = await import("@/lib/public-ssr-paths");
const { ssrCacheClassHeaders } = await import("@/route-response-policy");
const { Route: robotsRoute, robotsHandlers } =
  await import("@/routes/robots[.]txt");

const repoRoot = nodePath.resolve(import.meta.dir, "../../../..");
const readSource = async (path: string) =>
  await Bun.file(nodePath.resolve(repoRoot, path)).text();
const expectNoDirectAuthImport = (source: string) => {
  expect(source).not.toMatch(/@\/lib\/auth["']/u);
};

type RobotsRule = { kind: "allow" | "disallow"; pattern: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[] };

const parseRobotsGroups = (robotsTxt: string): RobotsGroup[] => {
  const groups: RobotsGroup[] = [];
  let group: RobotsGroup = { agents: [], rules: [] };
  for (const line of robotsTxt.split("\n")) {
    const directive = line.split("#", 1)[0]?.trim();
    if (!directive) {
      continue;
    }

    const separator = directive.indexOf(":");
    const name = directive.slice(0, separator).toLowerCase();
    const value = directive.slice(separator + 1).trim();
    if (name === "user-agent") {
      if (group.rules.length > 0) {
        groups.push(group);
        group = { agents: [], rules: [] };
      }
      group.agents.push(value.toLowerCase());
      continue;
    }

    if ((name === "allow" || name === "disallow") && value) {
      group.rules.push({ kind: name, pattern: value });
    }
  }
  if (group.agents.length > 0) {
    groups.push(group);
  }
  return groups;
};

const namedRobotsAgents = (robotsTxt: string) =>
  parseRobotsGroups(robotsTxt)
    .flatMap(({ agents }) => agents)
    .filter((agent) => agent !== "*");

/** Evaluates the group selection and longest matching rule emitted by these files. */
const robotsAllows = (
  groups: RobotsGroup[],
  userAgent: string,
  pathAndQuery: string,
): boolean => {
  const userAgentToken = userAgent.toLowerCase();
  const exactGroups = groups.filter((group) =>
    group.agents.some(
      (agent) => agent !== "*" && userAgentToken.includes(agent),
    ),
  );
  const selectedGroups = exactGroups.length
    ? exactGroups
    : groups.filter((group) => group.agents.includes("*"));
  const matchingRules = selectedGroups.flatMap(({ rules }) =>
    rules.filter(({ pattern }) => {
      const isEndAnchored = pattern.endsWith("$");
      const pathPattern = isEndAnchored ? pattern.slice(0, -1) : pattern;
      const expression = pathPattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*");
      const endAnchor = isEndAnchored ? "$" : "";
      return new RegExp(`^${expression}${endAnchor}`, "u").test(pathAndQuery);
    }),
  );
  const specificity = (pattern: string) =>
    pattern.replaceAll("*", "").replace(/\$$/u, "").length;
  const longestMatch = Math.max(
    -1,
    ...matchingRules.map(({ pattern }) => specificity(pattern)),
  );
  if (longestMatch < 0) {
    return true;
  }

  return matchingRules.some(
    ({ kind, pattern }) =>
      specificity(pattern) === longestMatch && kind === "allow",
  );
};

const requestUrlForTest = (input: Request | URL | string): string => {
  if (input instanceof URL) {
    return input.toString();
  }

  if (typeof input === "string") {
    return input;
  }

  return input.url;
};

describe("public law sitemap", () => {
  test.each(CASE_LAW_BROWSER_COUNTRIES)(
    "%s shard publication follows the public page countries",
    async (country) => {
      const segment = country.toLowerCase();
      const shard = {
        bucket: "all",
        country: segment,
        lastmod: "2026-01-01",
        month: "03",
        year: "2019",
      };
      const published = PUBLIC_CASE_LAW_PAGE_COUNTRIES.some(
        (candidate) => candidate === country,
      );
      const shards = await fetchPublicSitemapShards({
        fetchImpl: async () =>
          Response.json({ items: [shard], limit: 50_000, nextCursor: null }),
      });
      expect(shards).toEqual(published ? [shard] : []);
      const xml = createPublicLawSitemapIndexXml([shard], {
        publicLawIndexingEnabled: true,
      });
      expect(xml.includes(`/sitemaps/law-cases/${segment}/2019/03.xml`)).toBe(
        published,
      );
    },
  );

  test("app robots response blocks bulk and AI crawlers while retaining the deployment crawl policy", async () => {
    expect(robotsRoute.options.server?.handlers).toBe(robotsHandlers);
    const response = robotsHandlers.GET();

    const body = await response.text();
    const lines = body.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "# Automated scraping, bulk download and AI training on stella are not permitted.",
      "# Interested in our data? We license it: hello@stll.app",
    ]);
    const groups = parseRobotsGroups(body);
    for (const path of [
      "/api/v1/public",
      "/law/search?q=search",
      "/law/search?country=cze&query=search",
    ]) {
      expect(robotsAllows(groups, "Googlebot", path)).toBe(false);
    }
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(namedRobotsAgents(body).toSorted()).toEqual(
      PUBLIC_ROBOTS_DENIED_USER_AGENTS.map((userAgent) =>
        userAgent.toLowerCase(),
      ).toSorted(),
    );
    for (const userAgent of PUBLIC_ROBOTS_DENIED_USER_AGENTS) {
      const agentLine = `User-agent: ${userAgent}`;
      const agentIndex = lines.indexOf(agentLine);
      expect(agentIndex).toBeGreaterThanOrEqual(0);
      expect(lines[agentIndex + 1]).toBe("Disallow: /");
    }
  });

  test("landing robots rules block the same crawl classes and retain its sitemap", async () => {
    const robots = await readSource("apps/landing/public/robots.txt");
    const lines = robots.split("\n");

    expect(lines.slice(0, 2)).toEqual([
      "# Automated scraping, bulk download and AI training on stella are not permitted.",
      "# Interested in our data? We license it: hello@stll.app",
    ]);
    expect(lines).toContain("Disallow: /api/");
    expect(lines).toContain("Disallow: /*?q=");
    expect(lines).toContain("Disallow: /*&q=");
    expect(lines).toContain("Disallow: /*?query=");
    expect(lines).toContain("Disallow: /*&query=");
    expect(lines).toContain("Disallow: /law/*?q=");
    expect(lines).toContain("Disallow: /law/*&q=");
    expect(lines).toContain("Allow: /");
    expect(lines).toContain("Sitemap: https://stll.app/sitemap-index.xml");
    expect(namedRobotsAgents(robots).toSorted()).toEqual(
      PUBLIC_ROBOTS_DENIED_USER_AGENTS.map((userAgent) =>
        userAgent.toLowerCase(),
      ).toSorted(),
    );
  });

  test("robots path rules preserve public law and sitemap crawling while excluding searches", async () => {
    const appRobots = createRobotsTxt({
      publicLawCrawlAllowed: true,
      seoIndexable: true,
    });
    const landingRobots = await readSource("apps/landing/public/robots.txt");
    const policies = [
      { name: "app", groups: parseRobotsGroups(appRobots) },
      { name: "landing", groups: parseRobotsGroups(landingRobots) },
    ];
    const crawlablePaths = [
      "/law/cases",
      "/law/cze/statutes/constitution",
      "/sitemap.xml",
      "/sitemaps/law.xml",
    ];
    const excludedPaths = [
      "/api/v1/public",
      "/law/search?query=x",
      "/law/statutes/search?query=x",
      "/law/cases?q=x",
    ];

    for (const { name, groups } of policies) {
      for (const userAgent of ["Googlebot", "Bingbot", "OAI-SearchBot"]) {
        for (const path of crawlablePaths) {
          expect(
            robotsAllows(groups, userAgent, path),
            `${name}: ${userAgent} ${path}`,
          ).toBe(true);
        }
        for (const path of excludedPaths) {
          expect(
            robotsAllows(groups, userAgent, path),
            `${name}: ${userAgent} ${path}`,
          ).toBe(false);
        }
      }
      for (const userAgent of PUBLIC_ROBOTS_ALLOWED_SEARCH_USER_AGENTS) {
        for (const path of crawlablePaths) {
          expect(
            robotsAllows(groups, userAgent, path),
            `${name}: ${userAgent} ${path}`,
          ).toBe(true);
        }
      }

      for (const userAgent of PUBLIC_ROBOTS_DENIED_USER_AGENTS) {
        for (const path of crawlablePaths) {
          expect(
            robotsAllows(groups, userAgent, path),
            `${name}: ${userAgent} ${path}`,
          ).toBe(false);
        }
      }
    }
  });

  test("fetches public sitemap decisions from the public case-law API only", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: Request | URL | string) => {
      requestedUrls.push(requestUrlForTest(input));

      const body = {
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            caseNumber: "20 Cdo 470/2017",
            slug: "stable-official-slug",
            country: "CZE",
            court: "Nejvyssi soud",
            language: "cs",
            languageAlternates: [],
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        limit: 50_000,
        nextCursor: null,
      };

      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    };

    const decisions = await fetchPublicSitemapDecisions({
      fetchImpl,
      shard: { bucket: "all", country: "cze", month: "09", year: "2017" },
      signal: AbortSignal.timeout(1000),
    });

    expect(decisions).toHaveLength(1);
    expect(requestedUrls).toEqual([
      "http://localhost:3001/v1/case/sitemap/decisions/shard?country=cze&year=2017&month=09&bucket=all",
    ]);
  });

  test("fetches bucketed sitemap decisions from stable shard paths", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: Request | URL | string) => {
      requestedUrls.push(requestUrlForTest(input));

      return new Response(
        JSON.stringify({
          items: [],
          limit: 50_000,
          nextCursor: null,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };

    await fetchPublicSitemapDecisions({
      fetchImpl,
      shard: { bucket: "07", country: "cze", month: "05", year: "2026" },
      signal: AbortSignal.timeout(1000),
    });

    expect(requestedUrls).toEqual([
      "http://localhost:3001/v1/case/sitemap/decisions/shard?country=cze&year=2026&month=05&bucket=07",
    ]);
  });

  test.each([
    ["17", "17"],
    [String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER)],
    ["1e100", "60"],
    ["9007199254740992", "60"],
    ["Infinity", "60"],
    ["NaN", "60"],
    ["1.5", "60"],
    ["0", "60"],
    ["-1", "60"],
    ["", "60"],
  ])("normalizes retry delay %s to decimal seconds", (header, expected) => {
    const error = createSitemapUpstreamBusyError({
      action: "readPublicSitemap",
      response: new Response("busy", {
        status: 429,
        headers: { "Retry-After": header },
      }),
    });

    const response = createSitemapReadFailureResponse(error);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(expected);
    expect(response.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/u);
  });

  test("a budget refusal rejects with a retryable busy error", async () => {
    const fetchImpl = async () => new Response("busy", { status: 429 });

    const error = await rejectionOf(
      fetchPublicSitemapDecisions({
        fetchImpl,
        shard: { bucket: "all", country: "cze", month: "05", year: "2026" },
      }),
    );

    expect(SitemapUpstreamBusyError.is(error)).toBe(true);
    expect(createSitemapReadFailureResponse(error).status).toBe(429);
    expect(
      createSitemapReadFailureResponse(error).headers.get("Retry-After"),
    ).toBe("60");
  });

  test("fetches public sitemap shards from the public case-law API only", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: Request | URL | string) => {
      requestedUrls.push(requestUrlForTest(input));

      return new Response(
        JSON.stringify({
          items: [
            {
              bucket: "all",
              country: "cze",
              lastmod: "2026-01-01",
              month: "05",
              year: "2026",
            },
            {
              bucket: "07",
              country: "cze",
              lastmod: "2025-12-31",
              month: "04",
              year: "2026",
            },
            {
              bucket: "all",
              country: "xaa",
              lastmod: "2026-01-02",
              month: "06",
              year: "2026",
            },
          ],
          limit: 50_000,
          nextCursor: null,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };

    const shards = await fetchPublicSitemapShards({
      fetchImpl,
      signal: AbortSignal.timeout(1000),
    });

    expect(shards).toHaveLength(2);
    expect(requestedUrls).toEqual([
      "http://localhost:3001/v1/case/sitemap/shards",
    ]);
  });

  test("refuses a sitemap request outside the generated country list", async () => {
    let requested = false;
    const fetchImpl = async () => {
      requested = true;
      return new Response();
    };

    expect(
      await rejectionOf(
        fetchPublicSitemapDecisions({
          fetchImpl,
          shard: {
            bucket: "all",
            country: "xaa",
            month: "01",
            year: "2026",
          },
        }),
      ),
    ).toHaveProperty(
      "message",
      expect.stringContaining("The case-law sitemap shard is not published"),
    );
    expect(requested).toBe(false);
  });

  test("serializes the root sitemap index", () => {
    const xml = createPublicLawSitemapIndexXml(
      [
        {
          bucket: "all",
          country: "cze",
          lastmod: "2026-01-01",
          month: "05",
          year: "2026",
        },
        {
          bucket: "07",
          country: "cze",
          lastmod: "2025-12-31",
          month: "04",
          year: "2026",
        },
        {
          bucket: "all",
          country: "xaa",
          lastmod: "2026-01-02",
          month: "06",
          year: "2026",
        },
      ],
      { publicLawIndexingEnabled: true },
    );

    expect(xml).toContain("<sitemapindex");
    expect(xml).toContain("<loc>http://localhost:3000/sitemaps/law.xml</loc>");
    expect(xml).toContain(
      "<loc>http://localhost:3000/sitemaps/law-cases/cze/2026/05.xml</loc>",
    );
    expect(xml).toContain(
      "<loc>http://localhost:3000/sitemaps/law-cases/cze/2026/04/07.xml</loc>",
    );
    expect(xml).toContain("<lastmod>2026-01-01</lastmod>");
    expect(xml).not.toContain("cursor=");
    expect(xml).not.toContain("/xaa/");
    expect(xml).not.toContain("workspace");
    expect(xml).not.toContain("organization");
    expect(xml).not.toContain("matter");
  });

  test("serializes the static public law sitemap", () => {
    const xml = createPublicLawStaticSitemapXml({
      publicLawIndexingEnabled: true,
    });

    expect(xml).toContain("<loc>http://localhost:3000/law</loc>");
    expect(xml).not.toContain("http://localhost:3000/law/cases");
    expect(xml).not.toContain("workspace");
    expect(xml).not.toContain("organization");
    expect(xml).not.toContain("matter");
  });

  test("every static sitemap URL is allowed by robots.txt and its path policy", () => {
    const robots = createRobotsTxt({
      publicKnowledgeCrawlAllowed: false,
      publicLawCrawlAllowed: true,
      publicToolsCrawlAllowed: false,
      seoIndexable: true,
    });
    const allowed = (path: string): boolean =>
      robots
        .split("\n")
        .filter((line) => line.startsWith("Allow: "))
        .map((line) => line.slice("Allow: ".length))
        .some((rule) =>
          rule.endsWith("$")
            ? path === rule.slice(0, -1)
            : path.startsWith(rule),
        );
    const xml = createPublicLawStaticSitemapXml({
      publicLawIndexingEnabled: true,
    });
    const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(
      ([, loc]) => new URL(loc ?? "").pathname,
    );

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(allowed(path)).toBe(true);
      expect(isPublicLawPathIndexable(path, true)).toBe(true);
    }
    // Pages robots.txt leaves disallowed are neither listed nor indexable.
    for (const path of ["/law/coverage", "/law/cases/research", "/law/de/x"]) {
      expect(allowed(path)).toBe(false);
      expect(paths).not.toContain(path);
      expect(isPublicLawPathIndexable(path, true)).toBe(false);
    }
    expect(isPublicLawPathIndexable("/law", false)).toBe(false);
  });

  test("case-law shard sitemaps do not duplicate the case-law index URL", () => {
    const xml = createPublicCaseLawSitemapXml([
      {
        id: "11111111-1111-4111-8111-111111111111",
        caseNumber: "20 Cdo 470/2017",
        slug: "stable-official-slug",
        country: "CZE",
        court: "Nejvyssi soud",
        language: "cs",
        languageAlternates: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(xml).not.toContain("http://localhost:3000/law/cases</loc>");
    expect(xml).toContain(
      "http://localhost:3000/law/cze/cases/nejvyssi-soud/stable-official-slug",
    );
    expect(xml).not.toContain("xmlns:xhtml");
    expect(xml).not.toContain("hreflang");
  });

  test("case-law shard sitemaps include official language alternates only for multilingual decisions", () => {
    const xml = createPublicCaseLawSitemapXml([
      {
        id: "11111111-1111-4111-8111-111111111111",
        caseNumber: "C-123/22",
        slug: "c-123-22",
        country: "EU",
        court: "Court of Justice",
        language: "en",
        languageAlternates: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            caseNumber: "C-123/22",
            slug: "c-123-22",
            country: "EU",
            court: "Court of Justice",
            language: "en",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            caseNumber: "C-123/22",
            slug: "c-123-22-cs",
            country: "EU",
            court: "Court of Justice",
            language: "cs",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain(
      "http://localhost:3000/law/eu/cases/court-of-justice/en/c-123-22",
    );
    expect(xml).toContain(
      'hreflang="cs" href="http://localhost:3000/law/eu/cases/court-of-justice/cs/c-123-22-cs"',
    );
    expect(xml).toContain('hreflang="x-default"');
  });

  test("case-law shard sitemaps dedupe duplicate-language alternates", () => {
    const xml = createPublicCaseLawSitemapXml([
      {
        id: "11111111-1111-4111-8111-111111111111",
        caseNumber: "C-123/22",
        slug: "c-123-22",
        country: "EU",
        court: "Court of Justice",
        language: "en",
        languageAlternates: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            caseNumber: "C-123/22",
            slug: "c-123-22",
            country: "EU",
            court: "Court of Justice",
            language: "EN",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "33333333-3333-4333-8333-333333333333",
            caseNumber: "C-123/22",
            slug: "c-123-22-duplicate",
            country: "EU",
            court: "Court of Justice",
            language: "en",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            caseNumber: "C-123/22",
            slug: "c-123-22-cs",
            country: "EU",
            court: "Court of Justice",
            language: "cs",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(xml.match(/hreflang="en"/gu)).toHaveLength(1);
    expect(xml.match(/hreflang="cs"/gu)).toHaveLength(1);
  });

  test("case-law shard sitemaps do not add xhtml namespace for invalid alternates", () => {
    const xml = createPublicCaseLawSitemapXml([
      {
        id: "11111111-1111-4111-8111-111111111111",
        caseNumber: "C-123/22",
        slug: "c-123-22",
        country: "EU",
        court: "Court of Justice",
        language: "en",
        languageAlternates: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            caseNumber: "C-123/22",
            slug: "c-123-22",
            country: "EU",
            court: "Court of Justice",
            language: "not a language",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            caseNumber: "C-123/22",
            slug: "c-123-22-cs",
            country: "EU",
            court: "Court of Justice",
            language: "",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(xml).not.toContain("xmlns:xhtml");
    expect(xml).not.toContain("hreflang");
  });

  test("case-law shard sitemaps fail before exceeding the protocol byte limit", () => {
    expect(() =>
      assertPublicLawSitemapXmlWithinProtocolLimits("<urlset />", 5),
    ).toThrow("Public sitemap exceeded 5 bytes.");
  });

  test("root sitemap indexes fail before exceeding the protocol byte limit", () => {
    expect(() =>
      createPublicLawSitemapIndexXml(
        [
          {
            bucket: "all",
            country: "cze",
            lastmod: "2026-01-01",
            month: "05",
            year: "2026",
          },
        ],
        { publicLawIndexingEnabled: true },
      ),
    ).not.toThrow();

    expect(() =>
      createPublicLawSitemapIndexXml([], {
        maxBytes: 5,
        publicLawIndexingEnabled: true,
      }),
    ).toThrow("Public sitemap exceeded 5 bytes.");
  });

  test("sitemap XML responses are publicly cacheable", () => {
    expect(SITEMAP_XML_RESPONSE_HEADERS).toEqual({
      ...ssrCacheClassHeaders("public-anonymous"),
      "Cache-Control":
        "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400",
      "Content-Type": "application/xml; charset=utf-8",
    });
  });

  test("serializes public case-law URLs without private fields", () => {
    const xml = createPublicCaseLawSitemapXml([
      {
        id: "11111111-1111-4111-8111-111111111111",
        caseNumber: "20 Cdo 470/2017",
        slug: null,
        country: "CZE",
        court: "Nejvyssi soud",
        language: "cs",
        languageAlternates: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(xml).toContain("<lastmod>2026-01-01</lastmod>");
    expect(xml).toContain(
      "http://localhost:3000/law/cze/cases/nejvyssi-soud/20-cdo-470-2017",
    );
    expect(xml).toContain("<lastmod>2026-01-01</lastmod>");
    expect(xml).not.toContain("analysis");
    expect(xml).not.toContain("workspace");
    expect(xml).not.toContain("organization");
    expect(xml).not.toContain("matter");
  });

  test("robots fully blocks crawlers on non-indexable deployments", () => {
    const robots = createRobotsTxt({
      publicLawCrawlAllowed: false,
      seoIndexable: false,
    });

    expect(robots.startsWith("User-agent: *\nDisallow: /\n")).toBe(true);
    expect(robots).not.toContain("Disallow: /law/");
    expect(robots).not.toContain("Disallow: /workspaces");
    expect(robots).not.toContain("Sitemap:");
  });

  test("robots defaults to a full crawl block until the deployment is indexable", () => {
    // The env default leaves VITE_SEO_INDEXABLE off.
    expect(createRobotsTxt().startsWith("User-agent: *\nDisallow: /\n")).toBe(
      true,
    );
  });

  test("robots default-denies the whole host when indexable without crawl permission", () => {
    const robots = createRobotsTxt({
      publicLawCrawlAllowed: false,
      publicToolsCrawlAllowed: false,
      seoIndexable: true,
    });
    const lines = robots.split("\n");

    // No allow-list yet, so default-deny keeps every path (including /law) out.
    expect(lines).toContain("User-agent: *");
    expect(lines).toContain("Disallow: /");
    expect(lines.some((line) => line.startsWith("Allow:"))).toBe(false);
    expect(lines).not.toContain("Disallow: /law/");
    expect(lines).not.toContain("Disallow: /workspaces");
    expect(lines).toContain("Sitemap: http://localhost:3000/sitemap.xml");
  });

  test("robots allow-lists the public crawl prefixes when indexable and crawling is permitted", () => {
    const robots = createRobotsTxt({
      publicLawCrawlAllowed: true,
      seoIndexable: true,
    });
    const lines = robots.split("\n");
    const allowLines = lines.filter((line) => line.startsWith("Allow:"));

    // Boundary-anchored rules: dir prefixes emit a subtree + exact-path pair,
    // the sitemap.xml file prefix emits just the exact-path rule.
    expect(allowLines).toEqual([
      "Allow: /law$",
      // One subtree per pages-public jurisdiction, from the capability state.
      ...PUBLIC_CASE_LAW_PAGE_COUNTRIES.flatMap((country) => {
        const path = `/law/${toCaseLawCountryParam(country)}`;
        return [`Allow: ${path}/`, `Allow: ${path}$`];
      }),
      "Allow: /law/cases$",
      "Allow: /sitemap.xml$",
      "Allow: /sitemaps/",
      "Allow: /sitemaps$",
    ]);
    // A jurisdiction whose pages are not public stays behind Disallow: /.
    expect(allowLines.some((line) => line.startsWith("Allow: /law/svk"))).toBe(
      PUBLIC_CASE_LAW_PAGE_COUNTRIES.some((country) => country === "SVK"),
    );
    // Sibling-path regression: never emit a bare un-anchored prefix (which
    // would also match /lawyer, /law-admin, …). Every Allow rule ends in / or $.
    for (const line of allowLines) {
      expect(line.endsWith("/") || line.endsWith("$")).toBe(true);
    }
    expect(lines).toContain("Disallow: /");
    expect(lines).not.toContain("Disallow: /law/");
    expect(lines).toContain("Sitemap: http://localhost:3000/sitemap.xml");
  });

  test("robots allow-lists public tools independently of public law", () => {
    const robots = createRobotsTxt({
      publicLawCrawlAllowed: false,
      publicToolsCrawlAllowed: true,
      seoIndexable: true,
    });
    const allowLines = robots
      .split("\n")
      .filter((line) => line.startsWith("Allow:"));

    expect(allowLines).toEqual(
      publicToolCrawlPaths("/tools").map((path) => `Allow: ${path}$`),
    );
    expect(robots).toContain("Disallow: /");
  });

  test("robots opens the published template catalogue only behind the Knowledge crawl switch", () => {
    const allowLinesFor = (publicKnowledgeCrawlAllowed: boolean) =>
      createRobotsTxt({
        publicKnowledgeCrawlAllowed,
        publicLawCrawlAllowed: false,
        publicToolsCrawlAllowed: false,
        seoIndexable: true,
      })
        .split("\n")
        .filter((line) => line.startsWith("Allow:"));

    expect(allowLinesFor(true)).toEqual([
      "Allow: /knowledge/templates/catalogue/",
      "Allow: /knowledge/templates/catalogue$",
    ]);
    expect(allowLinesFor(false)).toEqual([]);
  });

  test("robots always default-denies for every flag combination", () => {
    for (const publicLawCrawlAllowed of [false, true]) {
      for (const publicToolsCrawlAllowed of [false, true]) {
        for (const seoIndexable of [false, true]) {
          const robots = createRobotsTxt({
            publicLawCrawlAllowed,
            publicToolsCrawlAllowed,
            seoIndexable,
          });
          expect(robots.split("\n")).toContain("Disallow: /");
        }
      }
    }
  });

  test("sitemaps are still served while a non-indexable deployment blocks crawlers", () => {
    // Sitemap serving keeps today's semantics (law && indexing) and is
    // independent of crawl permission, so verification tooling can fetch
    // sitemaps even while robots.txt blocks all crawlers.
    const indexXml = createPublicLawSitemapIndexXml(
      [
        {
          bucket: "all",
          country: "cze",
          lastmod: "2026-01-01",
          month: "05",
          year: "2026",
        },
      ],
      { publicLawIndexingEnabled: true },
    );
    const staticXml = createPublicLawStaticSitemapXml({
      publicLawIndexingEnabled: true,
    });
    const robots = createRobotsTxt({
      publicLawCrawlAllowed: false,
      seoIndexable: false,
    });

    expect(indexXml).toContain(
      "<loc>http://localhost:3000/sitemaps/law.xml</loc>",
    );
    expect(staticXml).not.toContain("http://localhost:3000/law/cases");
    expect(robots.startsWith("User-agent: *\nDisallow: /\n")).toBe(true);
  });

  test("dark-launched law sitemaps do not publish law URLs", () => {
    const indexXml = createPublicLawSitemapIndexXml([
      {
        bucket: "all",
        country: "cze",
        lastmod: "2026-01-01",
        month: "05",
        year: "2026",
      },
    ]);
    const staticXml = createPublicLawStaticSitemapXml();

    expect(indexXml).not.toContain("/law");
    expect(staticXml).not.toContain("/law");
  });

  test("root route does not load auth context for public SSR", async () => {
    const source = await readSource("apps/web/src/routes/__root.tsx");

    expect(source).not.toContain("sessionOptions");
    expect(source).not.toContain("loadAuthContext");
    expectNoDirectAuthImport(source);
  });

  test("root route streams only public law app paths", async () => {
    const source = await readSource("apps/web/src/routes/__root.tsx");

    expect(isPublicSsrPath("/law")).toBe(true);
    expect(isPublicSsrPath("/law/cases")).toBe(true);
    expect(isPublicSsrPath("/law/cze/cases/court/2026-01-01/slug")).toBe(true);
    expect(isPublicSsrPath("/auth")).toBe(false);
    expect(isPublicSsrPath("/workspaces/workspace-id")).toBe(false);
    expect(isPublicSsrPath("/")).toBe(false);
    expect(source).toContain(
      "ssr: ({ location: routeLocation }) => isPublicSsrPath(routeLocation.pathname)",
    );
    expect(source).toContain("shellComponent: RootDocument");
  });

  test("server entry preserves streaming SSR for public SEO routes", async () => {
    const source = await readSource("apps/web/src/server.ts");

    expect(source).toContain("@tanstack/react-start/server-entry");
    expect(source).not.toContain("defaultRenderHandler");
    expect(source).not.toContain("defaultStreamHandler");
  });

  test("server router does not render scroll restoration during SSR", async () => {
    const source = await readSource("apps/web/src/router.tsx");

    expect(source).toContain("scrollRestoration: !import.meta.env.SSR");
  });

  test("protected workspace route opts out of server rendering", async () => {
    const source = await readSource("apps/web/src/routes/_protected.tsx");

    expect(source).toContain("ssr: false");
    // A nested pending state renders content only; the shell owns its chrome.
    expect(source).toContain("pendingComponent: DefaultPendingComponent");
    expect(source).not.toContain("ProtectedPendingSkeleton");
  });

  test("document routes do not prefetch parent overview billing data", async () => {
    const source = await readSource(
      "apps/web/src/routes/_protected.workspaces/$workspaceId/$viewId.route.tsx",
    );

    // The document page comes from the route matches (see
    // use-workspace-view-params.dom.test.tsx), read in beforeLoad.
    expect(source).toContain(
      "return { documentOnScreen: getCurrentWorkspaceDocument(matches) };",
    );
    expect(source).toContain(
      "const isDocumentRoute = context.documentOnScreen !== undefined;",
    );
    expect(source).toContain("if (isDocumentRoute)");
    expect(source).toContain("timeEntrySummaryOptions(");
  });

  test("public case-law list route preloads first page for SSR links", async () => {
    const [source, facets] = await Promise.all([
      readSource("apps/web/src/routes/law/cases/index.tsx"),
      readSource("apps/web/src/features/case-law/decision-filter-facets.ts"),
    ]);

    expect(source).toContain("loader:");
    expect(source).toContain("ensureRouteQueryData");
    expect(source).toContain("await prefetchDecisionFacetsAfterSearch({");
    expect(source).toContain("country: scope,");
    expect(facets).toContain("search.finally(");
    expect(facets).toContain("prefetchRouteQuery(");
    expect(facets).toContain("decisionFacetsOptions(country)");
    expect(source).not.toContain("decisionFacetsOptions()");
    expect(source).toContain("decisionsPageOptions(");
    expect(source).toContain("validateSearch: searchSchema");
  });

  test("the jurisdiction switch is shell chrome, offering every launch-ready country", async () => {
    const [shell, control] = await Promise.all([
      readSource("apps/web/src/routes/law/-components/public-law-shell.tsx"),
      readSource(
        "apps/web/src/features/case-law/components/top-bar-country.tsx",
      ),
    ]);

    // One instance, rendered by the shell: a page publishing its own would
    // publish one per live route match.
    expect(shell).toContain("<TopBarCountry />");
    expect(control).toContain("PUBLIC_CASE_LAW_COUNTRIES");
    expect(control).toContain("countryScopedLawRoute");
  });

  test("public law home preloads its shelves for SSR", async () => {
    const source = await readSource("apps/web/src/routes/law/index.tsx");

    expect(source).toContain("validateSearch: searchSchema");
    expect(source).toContain("latestDecisionsOptions(scope)");
    expect(source).toContain("legislationShelfOptions(scope)");
    expect(source).toContain("createLegalCollectionJsonLd");
  });

  test("public law SSR modules do not statically import auth", async () => {
    const sources = await Promise.all([
      readSource("apps/web/src/routes/law/route.tsx"),
      readSource("apps/web/src/routes/law/-components/public-law-shell.tsx"),
      readSource(
        "apps/web/src/features/case-law/components/case-viewer/decision-workspace.tsx",
      ),
    ]);

    for (const source of sources) {
      expect(source).not.toContain("@/routes/-auth-context");
      expect(source).not.toContain("@/lib/auth-queries");
      expect(source).not.toContain("@/routes/_protected");
      expectNoDirectAuthImport(source);
    }
  });

  test("public and protected workspace sidebars share the same primary nav model", async () => {
    const sources = await Promise.all([
      readSource("apps/web/src/components/app-sidebar.tsx"),
      readSource("apps/web/src/components/public-workspace-shell.tsx"),
    ]);

    for (const source of sources) {
      expect(source).toContain("getWorkspacePrimaryNavItems");
    }
  });

  test("case-law navigation is filtered by the shared dark-launch helper", async () => {
    const [navSource, appSidebarSource, publicShellSource] = await Promise.all([
      readSource("apps/web/src/components/workspace-primary-nav.ts"),
      readSource("apps/web/src/components/app-sidebar.tsx"),
      readSource("apps/web/src/components/public-workspace-shell.tsx"),
    ]);

    expect(navSource).toContain("getWorkspacePrimaryNavItems");
    expect(navSource).toContain('if (item.id === "caseLaw")');
    expect(navSource).toContain("return includePublicLaw");
    expect(appSidebarSource).toContain("usePublicLawPreviewEnabled");
    // The server-rendered shell must use the isomorphic host/env gate;
    // the browser-only preview hook would mismatch hydration there.
    expect(publicShellSource).toContain("isPublicLawSsrRouteEnabled");
    expect(publicShellSource).not.toContain("isPublicLawRouteEnabled");
    expect(publicShellSource).not.toContain("usePublicLawPreviewEnabled");
  });

  test("direct case-law callers are filtered by the shared dark-launch helper", async () => {
    const [
      chatLinkGateSource,
      chatOpenSource,
      chatStatuteOpenSource,
      chatMentionSource,
      searchSource,
    ] = await Promise.all([
      readSource("apps/web/src/components/chat/public-law-open.ts"),
      readSource("apps/web/src/components/chat/case-law-open.ts"),
      readSource("apps/web/src/components/chat/statute-open.ts"),
      readSource(
        "apps/web/src/features/chat/hooks/use-global-chat-mention-registration.ts",
      ),
      readSource("apps/web/src/components/search-dialog.tsx"),
    ]);

    expect(chatLinkGateSource).toContain("isPublicLawPreviewEnabled");
    expect(chatOpenSource).toContain("openPublicLawLink");
    expect(chatStatuteOpenSource).toContain("openPublicLawLink");
    expect(chatOpenSource).toContain("defaultCaseLawCountryForLocale");
    expect(chatMentionSource).toContain("usePublicLawPreviewEnabled");
    expect(chatMentionSource).toContain("defaultCaseLawCountryForLocale");
    expect(chatMentionSource).toContain("country !== null");
    expect(searchSource).toContain("isPublicLawPreviewEnabled");
    expect(searchSource).toContain("usePublicLawPreviewEnabled");
  });

  test("start client orders i18n around hydration per path kind", async () => {
    const [entry, source] = await Promise.all([
      readSource("apps/web/src/client.tsx"),
      readSource("apps/web/src/client-runtime.tsx"),
    ]);
    expect(entry).toContain('import("@/client-runtime")');

    // Public SSR paths hydrate first (against the server's English) and
    // load the persisted locale after first paint; app paths keep the
    // resolve-locale-then-hydrate boot model.
    expect(source).toContain('from "@stll/ssr-kit/hydration"');
    expect(source).toMatch(
      /detached\(\s*bootHydratedClient\(\{\s*type:\s*isPublicSsrPath\(window\.location\.pathname\)\s*\?\s*"server-rendered"\s*:\s*"client-rendered",\s*hydrate,\s*initializeClientState:\s*initializeI18n,\s*\}\),\s*"client\.i18n",\s*\);/u,
    );
  });

  test("app provider preserves browser time zones for app timestamps", async () => {
    const timeZoneSource = await readSource("apps/web/src/i18n/time-zone.ts");

    expect(timeZoneSource).toContain('const SERVER_I18N_TIME_ZONE = "UTC"');
    expect(timeZoneSource).toContain(
      "Intl.DateTimeFormat().resolvedOptions().timeZone",
    );
    expect(timeZoneSource).toContain('globalThis.addEventListener("focus"');
    expect(timeZoneSource).toContain('globalThis.removeEventListener("focus"');

    const providerSource = await readSource("apps/web/src/app-providers.tsx");
    expect(providerSource).toContain(
      "useHydrationSafeTimeZone(synchronizeFormatterTimeZone)",
    );
    expect(providerSource).toContain("timeZone={timeZone}");
  });

  test("case-law list keeps date-only legal dates in UTC", async () => {
    // The shared decision cells own the date rendering; every surface that
    // draws a decision row (the public results, a matter's linked case law)
    // draws dates through them.
    const [cellsSource, columnsSource, tableSource] = await Promise.all([
      readSource(
        "apps/web/src/features/case-law/components/decision-cells.tsx",
      ),
      readSource("apps/web/src/features/case-law/decision-table-columns.tsx"),
      readSource(
        "apps/web/src/features/case-law/components/decision-table.tsx",
      ),
    ]);

    expect(cellsSource).toContain('timeZone: "UTC"');
    // The table builds every cell, dates included, from the shared column
    // model rather than formatting on its own.
    expect(columnsSource).toContain("decisionTableSchema");
    expect(columnsSource).not.toContain("format.dateTime(");
    expect(tableSource).not.toContain("format.dateTime(");
  });

  test("case-law AI mode requires an explicit authenticated availability gate", () => {
    // Bound to the component's own props rather than to its source text: a
    // renamed member, a boolean flag in place of the union, or the gate moved
    // onto the visitor's branch all fail to compile here, where a text mirror
    // would have to be hand-updated and would pass until someone noticed.
    type AiMode = DecisionWorkspaceProps["aiMode"];
    type AuthenticatedMode = Extract<
      DecisionWorkspaceProps,
      { aiMode: "enabled" }
    >;
    type VisitorMode = Extract<DecisionWorkspaceProps, { aiMode: "gated" }>;

    // Total over the union, so a mode added later has to say whether it may
    // start a run instead of inheriting the authenticated answer.
    const runsAnalysis = {
      enabled: true,
      gated: false,
    } as const satisfies Record<AiMode, boolean>;

    const authenticatedCarriesGate: CarriesAvailabilityGate<AuthenticatedMode> = true;
    const visitorCarriesGate: CarriesAvailabilityGate<VisitorMode> = false;

    expect(
      Object.entries(runsAnalysis)
        .filter(([, runs]) => runs)
        .map(([mode]) => mode),
    ).toEqual(["enabled"]);
    expect(authenticatedCarriesGate).toBe(true);
    expect(visitorCarriesGate).toBe(false);
  });

  test("public text routes do not import auth or protected modules", async () => {
    const sources = await Promise.all([
      readSource("apps/web/src/routes/robots[.]txt.ts"),
      readSource("apps/web/src/routes/sitemap[.]xml.ts"),
      readSource("apps/web/src/routes/sitemaps/law[.]xml.ts"),
      readSource(
        "apps/web/src/routes/sitemaps/law-cases/$country/$year/{$month}[.]xml.ts",
      ),
      readSource(
        "apps/web/src/routes/sitemaps/law-cases/$country/$year/$month/{$bucket}[.]xml.ts",
      ),
      readSource("apps/web/src/lib/public-law-sitemap.ts"),
    ]);

    for (const source of sources) {
      expect(source).not.toContain("@/routes/-auth-context");
      expect(source).not.toContain("@/lib/auth-queries");
      expect(source).not.toContain("@/routes/_protected");
      expectNoDirectAuthImport(source);
      expect(source).not.toContain("@/api/");
    }
  });
});
