import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

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
const { WORKSPACE_PRIMARY_NAV_ITEMS } =
  await import("@/components/workspace-primary-nav");

const repoRoot = resolve(import.meta.dir, "../../../..");
const readSource = async (path: string) =>
  await Bun.file(resolve(repoRoot, path)).text();
const expectNoDirectAuthImport = (source: string) => {
  expect(source).not.toMatch(/@\/lib\/auth["']/u);
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
            decisionDate: "2017-09-20",
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
    expect(xml).not.toContain("workspace");
    expect(xml).not.toContain("organization");
    expect(xml).not.toContain("matter");
  });

  test("serializes the static public law sitemap", () => {
    const xml = createPublicLawStaticSitemapXml({
      publicLawIndexingEnabled: true,
    });

    expect(xml).toContain("http://localhost:3000/law/cases");
    expect(xml).not.toContain("workspace");
    expect(xml).not.toContain("organization");
    expect(xml).not.toContain("matter");
  });

  test("case-law shard sitemaps do not duplicate the case-law index URL", () => {
    const xml = createPublicCaseLawSitemapXml([
      {
        id: "11111111-1111-4111-8111-111111111111",
        caseNumber: "20 Cdo 470/2017",
        slug: "stable-official-slug",
        country: "CZE",
        court: "Nejvyssi soud",
        decisionDate: "2017-09-20",
        language: "cs",
        languageAlternates: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(xml).not.toContain("http://localhost:3000/law/cases</loc>");
    expect(xml).toContain(
      "http://localhost:3000/law/cze/cases/nejvyssi-soud/2017-09-20/stable-official-slug",
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
        decisionDate: "2024-03-07",
        language: "en",
        languageAlternates: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            caseNumber: "C-123/22",
            slug: "c-123-22",
            country: "EU",
            court: "Court of Justice",
            decisionDate: "2024-03-07",
            language: "en",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            caseNumber: "C-123/22",
            slug: "c-123-22-cs",
            country: "EU",
            court: "Court of Justice",
            decisionDate: "2024-03-07",
            language: "cs",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain(
      "http://localhost:3000/law/eu/cases/court-of-justice/2024-03-07/en/c-123-22",
    );
    expect(xml).toContain(
      'hreflang="cs" href="http://localhost:3000/law/eu/cases/court-of-justice/2024-03-07/cs/c-123-22-cs"',
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
        decisionDate: "2024-03-07",
        language: "en",
        languageAlternates: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            caseNumber: "C-123/22",
            slug: "c-123-22",
            country: "EU",
            court: "Court of Justice",
            decisionDate: "2024-03-07",
            language: "EN",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "33333333-3333-4333-8333-333333333333",
            caseNumber: "C-123/22",
            slug: "c-123-22-duplicate",
            country: "EU",
            court: "Court of Justice",
            decisionDate: "2024-03-07",
            language: "en",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            caseNumber: "C-123/22",
            slug: "c-123-22-cs",
            country: "EU",
            court: "Court of Justice",
            decisionDate: "2024-03-07",
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
        decisionDate: "2024-03-07",
        language: "en",
        languageAlternates: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            caseNumber: "C-123/22",
            slug: "c-123-22",
            country: "EU",
            court: "Court of Justice",
            decisionDate: "2024-03-07",
            language: "not a language",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            caseNumber: "C-123/22",
            slug: "c-123-22-cs",
            country: "EU",
            court: "Court of Justice",
            decisionDate: "2024-03-07",
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
    ).toThrow("Public case-law sitemap exceeded 5 bytes.");
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
    ).toThrow("Public case-law sitemap exceeded 5 bytes.");
  });

  test("sitemap XML responses are publicly cacheable", () => {
    expect(SITEMAP_XML_RESPONSE_HEADERS).toEqual({
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
        decisionDate: "2017-09-20",
        language: "cs",
        languageAlternates: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(xml).toContain("<lastmod>2026-01-01</lastmod>");
    expect(xml).toContain(
      "http://localhost:3000/law/cze/cases/nejvyssi-soud/2017-09-20/20-cdo-470-2017",
    );
    expect(xml).toContain("<lastmod>2026-01-01</lastmod>");
    expect(xml).not.toContain("analysis");
    expect(xml).not.toContain("workspace");
    expect(xml).not.toContain("organization");
    expect(xml).not.toContain("matter");
  });

  test("robots disallows public law by default and private workspace routes always", () => {
    const robots = createRobotsTxt();

    expect(robots).toContain("Disallow: /law/");
    expect(robots).toContain("Disallow: /workspaces");
    expect(robots).toContain("Disallow: /knowledge");
    expect(robots).toContain("Disallow: /chat");
    expect(robots).toContain("Sitemap: http://localhost:3000/sitemap.xml");
  });

  test("robots allows public law only when indexing is explicitly enabled", () => {
    const robots = createRobotsTxt({ publicLawIndexingEnabled: true });

    expect(robots).toContain("Allow: /law/");
    expect(robots).not.toContain("Disallow: /law/");
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
    expect(source).toContain("pendingComponent: () => null");
  });

  test("public case-law list route preloads first page for SSR links", async () => {
    const source = await readSource("apps/web/src/routes/law/cases/index.tsx");

    expect(source).toContain("loader:");
    expect(source).toContain("ensureInfiniteQueryData");
    expect(source).toContain(
      "ensureCriticalQueryData(queryClient, decisionFacetsOptions())",
    );
    expect(source).toContain("decisionsInfiniteOptions(");
    expect(source).toContain("validateSearch: searchSchema");
    expect(source).toContain("CaseLawBrowseLinks");
    expect(source).toContain('to="/law/cases"');
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
      expect(source).not.toContain("@/routes/-queries");
      expect(source).not.toContain("@/routes/_protected");
      expectNoDirectAuthImport(source);
    }
  });

  test("public and protected workspace sidebars share the same primary nav model", async () => {
    const sources = await Promise.all([
      readSource("apps/web/src/components/app-sidebar.tsx"),
      readSource("apps/web/src/routes/law/-components/public-law-shell.tsx"),
    ]);

    expect(WORKSPACE_PRIMARY_NAV_ITEMS.map((item) => item.id)).toEqual([
      "search",
      "chat",
      "matters",
      "caseLaw",
      "knowledge",
      "contacts",
    ]);

    for (const source of sources) {
      expect(source).toContain("getWorkspacePrimaryNavItems");
    }
  });

  test("case-law navigation is filtered by the shared dark-launch helper", async () => {
    const [navSource, appSidebarSource, publicShellSource] = await Promise.all([
      readSource("apps/web/src/components/workspace-primary-nav.ts"),
      readSource("apps/web/src/components/app-sidebar.tsx"),
      readSource("apps/web/src/routes/law/-components/public-law-shell.tsx"),
    ]);

    expect(navSource).toContain("getWorkspacePrimaryNavItems");
    expect(navSource).toContain('item.id !== "caseLaw"');
    expect(appSidebarSource).toContain("usePublicLawPreviewEnabled");
    expect(publicShellSource).toContain("usePublicLawPreviewEnabled");
  });

  test("case-law AI mode requires an explicit authenticated availability gate", async () => {
    const source = await readSource(
      "apps/web/src/features/case-law/components/case-viewer/decision-workspace.tsx",
    );

    expect(source).toContain('aiMode: "locked"');
    expect(source).toContain('aiMode: "enabled"');
    expect(source).toContain("ensureAIAvailable: () => Promise<boolean>");
    expect(source).not.toContain("aiEnabled: boolean");
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
      expect(source).not.toContain("@/routes/-queries");
      expect(source).not.toContain("@/routes/_protected");
      expectNoDirectAuthImport(source);
      expect(source).not.toContain("@/api/");
    }
  });
});
