import { describe, expect, test } from "bun:test";

Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
});

const {
  createPublicStatuteSitemapXml,
  createStatuteSitemapShardPath,
  fetchPublicStatuteSitemapShards,
  fetchPublicStatuteSitemapWorks,
} = await import("@/features/statutes/statute-sitemap");
const { createPublicLawSitemapIndexXml } =
  await import("@/lib/public-law-sitemap");

const requestUrlForTest = (input: Request | URL | string): string => {
  if (input instanceof URL) {
    return input.toString();
  }

  if (typeof input === "string") {
    return input;
  }

  return input.url;
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

describe("public statute sitemap", () => {
  test("fetches statute sitemap shards from the public statute API only", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: Request | URL | string) => {
      requestedUrls.push(requestUrlForTest(input));

      return jsonResponse({
        items: [
          { bucket: "all", country: "cze", lastmod: "2026-03-04" },
          { bucket: "07", country: "svk", lastmod: "2026-01-15" },
          // A jurisdiction the statutes browser does not route.
          { bucket: "all", country: "xaa", lastmod: "2026-02-02" },
        ],
        limit: 50_000,
        nextCursor: null,
      });
    };

    const shards = await fetchPublicStatuteSitemapShards({
      fetchImpl,
      signal: AbortSignal.timeout(1000),
    });

    expect(shards.unwrapOr([]).map(({ country }) => country)).toEqual([
      "cze",
      "svk",
    ]);
    expect(requestedUrls).toEqual([
      "http://localhost:3001/v1/law/sitemap/shards",
    ]);
  });

  test("fetches one shard's statutes from a stable shard path", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: Request | URL | string) => {
      requestedUrls.push(requestUrlForTest(input));

      return jsonResponse({
        items: [
          {
            country: "CZE",
            lastmod: "2026-03-04",
            slug: "89-2012-sb-obcansky-zakonik",
          },
        ],
        limit: 5000,
        nextCursor: null,
      });
    };

    const works = await fetchPublicStatuteSitemapWorks({
      fetchImpl,
      shard: { bucket: "07", country: "cze" },
      signal: AbortSignal.timeout(1000),
    });

    expect(works.unwrapOr([])).toHaveLength(1);
    expect(requestedUrls).toEqual([
      "http://localhost:3001/v1/law/sitemap/statutes/shard?country=cze&bucket=07",
    ]);
  });

  test("refuses a statute shard outside the statutes browser jurisdictions", async () => {
    let requested = false;
    const fetchImpl = async () => {
      requested = true;
      return new Response();
    };

    const works = await fetchPublicStatuteSitemapWorks({
      fetchImpl,
      shard: { bucket: "all", country: "xaa" },
    });

    expect(works.isErr()).toBe(true);
    expect(requested).toBe(false);
  });

  test("an unreadable shard is an error value, not a thrown response", async () => {
    const fetchImpl = async () => new Response("nope", { status: 502 });

    const works = await fetchPublicStatuteSitemapWorks({
      fetchImpl,
      shard: { bucket: "all", country: "cze" },
    });

    expect(works.isErr()).toBe(true);
  });

  test("a shard payload of the wrong shape is an error value", async () => {
    const fetchImpl = async () => jsonResponse({ items: [{ slug: 1 }] });

    const works = await fetchPublicStatuteSitemapWorks({
      fetchImpl,
      shard: { bucket: "all", country: "cze" },
    });

    expect(works.isErr()).toBe(true);
  });

  test("shard sitemaps address a Work at its latest consolidation", () => {
    const xml = createPublicStatuteSitemapXml([
      {
        country: "CZE",
        lastmod: "2026-03-04",
        slug: "89-2012-sb-obcansky-zakonik",
      },
      {
        country: "SVK",
        lastmod: "2026-01-15",
        slug: "40-1964-zz-obciansky-zakonnik",
      },
    ]);

    expect(xml).toContain(
      "<loc>http://localhost:3000/law/cze/statutes/89-2012-sb-obcansky-zakonik</loc>",
    );
    expect(xml).toContain(
      "<loc>http://localhost:3000/law/svk/statutes/40-1964-zz-obciansky-zakonnik</loc>",
    );
    expect(xml).toContain("<lastmod>2026-03-04</lastmod>");
    // A dated consolidation is the same text at another address.
    expect(xml).not.toContain("/v/");
    expect(xml).not.toContain("workspace");
    expect(xml).not.toContain("matter");
  });

  test("shard sitemaps omit a slug the statute router would not resolve", () => {
    const xml = createPublicStatuteSitemapXml([
      { country: "CZE", lastmod: "2026-03-04", slug: "Not A Slug" },
    ]);

    expect(xml).not.toContain("<loc>");
  });

  test("statute shard paths split the all-bucket and bucketed families", () => {
    expect(
      createStatuteSitemapShardPath({ bucket: "all", country: "cze" }),
    ).toBe("/sitemaps/law-statutes/cze.xml");
    expect(
      createStatuteSitemapShardPath({ bucket: "07", country: "cze" }),
    ).toBe("/sitemaps/law-statutes/cze/07.xml");
  });

  test("the root sitemap index lists the statute shards beside the case-law shards", () => {
    const xml = createPublicLawSitemapIndexXml(
      [
        {
          bucket: "all",
          country: "cze",
          lastmod: "2026-01-01",
          month: "05",
          year: "2026",
        },
      ],
      {
        publicLawIndexingEnabled: true,
        statuteShards: [
          { bucket: "all", country: "cze", lastmod: "2026-03-04" },
          { bucket: "07", country: "svk", lastmod: "2026-01-15" },
          { bucket: "all", country: "xaa", lastmod: "2026-02-02" },
        ],
      },
    );

    expect(xml).toContain(
      "<loc>http://localhost:3000/sitemaps/law-cases/cze/2026/05.xml</loc>",
    );
    expect(xml).toContain(
      "<loc>http://localhost:3000/sitemaps/law-statutes/cze.xml</loc>",
    );
    expect(xml).toContain(
      "<loc>http://localhost:3000/sitemaps/law-statutes/svk/07.xml</loc>",
    );
    expect(xml).not.toContain("/xaa");
  });

  test("a dark-launched law surface publishes no statute shards", () => {
    const xml = createPublicLawSitemapIndexXml([], {
      publicLawIndexingEnabled: false,
      publicToolsIndexingEnabled: false,
      statuteShards: [{ bucket: "all", country: "cze", lastmod: "2026-03-04" }],
    });

    expect(xml).not.toContain("law-statutes");
  });
});
