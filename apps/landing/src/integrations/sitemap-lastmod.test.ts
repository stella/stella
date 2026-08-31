import { describe, expect, test } from "bun:test";

import {
  lastmodFromDates,
  parseGitLog,
  sitemapSources,
} from "./sitemap-lastmod";

const localeTagByPath = new Map([
  ["cs", "cs"],
  ["pt-br", "pt-BR"],
]);

const sources = (pathname: string) =>
  sitemapSources({ pathname, localeTagByPath });

describe("sitemapSources", () => {
  test("home pages date from the home component and their locale catalog", () => {
    expect(sources("/")).toEqual([
      "apps/landing/src/components/HomePage.astro",
      "apps/landing/src/data/product-story.ts",
      "apps/landing/src/i18n/messages/en.json",
    ]);
    expect(sources("/pt-br/")).toContain(
      "apps/landing/src/i18n/messages/pt-BR.json",
    );
  });

  test("product pages date from their product module and locale catalog", () => {
    expect(sources("/cs/product/editor/")).toEqual([
      "apps/landing/src/data/products/editor.ts",
      "apps/landing/src/components/ProductPage.astro",
      "apps/landing/src/i18n/product-copy.ts",
      "apps/landing/src/i18n/messages/cs.json",
    ]);
  });

  test("docs pages try both markdown extensions", () => {
    expect(sources("/docs/")).toEqual([
      "apps/landing/src/content/docs/docs/index.md",
      "apps/landing/src/content/docs/docs/index.mdx",
    ]);
    expect(sources("/docs/get-started/cli/")).toEqual([
      "apps/landing/src/content/docs/docs/get-started/cli.md",
      "apps/landing/src/content/docs/docs/get-started/cli.mdx",
    ]);
  });

  test("blog posts date from their content file, the index from the directory", () => {
    expect(sources("/blog/relicensing-to-apache-2-0/")).toEqual([
      "apps/landing/src/content/blog/relicensing-to-apache-2-0.md",
    ]);
    expect(sources("/blog/")).toContain("apps/landing/src/content/blog/");
  });

  test("utility pages are mapped explicitly", () => {
    expect(sources("/changelog/")).toContain("docs/changelog/");
    expect(sources("/security/")).toContain(
      "apps/landing/src/data/security-controls.ts",
    );
  });

  test("unmapped pages panic instead of inheriting a date", () => {
    expect(() => sources("/nowhere/")).toThrow("no source mapping");
    expect(() => sources("/cs/docs/")).toThrow("localized page");
    expect(() => sources("/product/editor/extra/")).toThrow(
      "no source mapping",
    );
  });
});

describe("lastmodFromDates", () => {
  const dates = new Map([
    ["a.ts", "2026-08-01T10:00:00+02:00"],
    ["b.ts", "2026-08-01T09:30:00Z"],
    ["dir/x.md", "2026-07-01T00:00:00Z"],
    ["dir/y.md", "2026-07-15T00:00:00Z"],
  ]);

  test("picks the newest instant, comparing across offsets", () => {
    expect(lastmodFromDates(["a.ts", "b.ts"], dates)).toBe(
      "2026-08-01T09:30:00.000Z",
    );
  });

  test("skips absent candidates and expands directories", () => {
    expect(lastmodFromDates(["missing.md", "dir/"], dates)).toBe(
      "2026-07-15T00:00:00.000Z",
    );
  });

  test("panics when no source has history", () => {
    expect(() => lastmodFromDates(["missing.md"], dates)).toThrow(
      "none of the sources exist",
    );
  });
});

describe("parseGitLog", () => {
  test("keeps the first (newest) date per path", () => {
    const log = [
      "2026-08-30T12:00:00+02:00",
      "",
      "apps/landing/src/pages/press.astro",
      "docs/changelog/v0.7.31.md",
      "",
      "2026-08-01T12:00:00+02:00",
      "",
      "apps/landing/src/pages/press.astro",
      "apps/landing/src/data/ai-facts.ts",
    ].join("\n");
    const parsed = parseGitLog(log);
    expect(parsed.get("apps/landing/src/pages/press.astro")).toBe(
      "2026-08-30T12:00:00+02:00",
    );
    expect(parsed.get("apps/landing/src/data/ai-facts.ts")).toBe(
      "2026-08-01T12:00:00+02:00",
    );
    expect(parsed.size).toBe(3);
  });
});
