import { describe, expect, test } from "bun:test";

Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
});

const {
  createPublicToolsSitemapXml,
  SITEMAP_XML_RESPONSE_HEADERS,
  TOOLS_SITEMAP_PATH,
} = await import("@/lib/public-tools-sitemap");
const { createPublicLawSitemapIndexXml } =
  await import("@/lib/public-law-sitemap");

describe("public tools sitemap", () => {
  test("dark-launched tools sitemap publishes no tool URLs", () => {
    const xml = createPublicToolsSitemapXml({
      publicToolsIndexingEnabled: false,
    });

    expect(xml).toContain("<urlset");
    expect(xml).not.toContain("/tools");
  });

  test("enabled tools sitemap lists the static browse surfaces", () => {
    const xml = createPublicToolsSitemapXml({
      publicToolsIndexingEnabled: true,
    });

    expect(xml).toContain("<loc>http://localhost:3000/tools</loc>");
    expect(xml).toContain("<loc>http://localhost:3000/tools/contribute</loc>");
    expect(xml).not.toContain("organization");
    expect(xml).not.toContain("workspace");
  });

  test("root sitemap index registers the tools sitemap when tools indexing is on", () => {
    const withTools = createPublicLawSitemapIndexXml([], {
      publicLawIndexingEnabled: false,
      publicToolsIndexingEnabled: true,
    });
    expect(withTools).toContain(
      `<loc>http://localhost:3000${TOOLS_SITEMAP_PATH}</loc>`,
    );

    const withoutTools = createPublicLawSitemapIndexXml([], {
      publicLawIndexingEnabled: false,
      publicToolsIndexingEnabled: false,
    });
    expect(withoutTools).not.toContain(TOOLS_SITEMAP_PATH);
  });

  test("tools sitemap responses reuse the shared cacheable headers", () => {
    expect(SITEMAP_XML_RESPONSE_HEADERS).toEqual({
      "Cache-Control":
        "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400",
      "Content-Type": "application/xml; charset=utf-8",
    });
  });
});
