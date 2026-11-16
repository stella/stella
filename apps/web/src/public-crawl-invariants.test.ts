import { describe, expect, test } from "bun:test";

Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
});

const { PUBLIC_CASE_LAW_PAGE_COUNTRIES, toCaseLawCountryParam } =
  await import("@/features/case-law/case-law-jurisdiction");
const { createPublicLawHead } = await import("@/lib/public-law-seo");
const { createPublicLawStaticSitemapXml, createRobotsTxt } =
  await import("@/lib/public-law-sitemap");
const { isPublicLawPathIndexable, isPublicLawUrlIndexable } =
  await import("@/public-crawl-policy");

type RobotsRule = { allow: boolean; pattern: string };

/** The `User-agent: *` group's path rules, in file order. */
const parseRobots = (robots: string): RobotsRule[] => {
  const rules: RobotsRule[] = [];
  let inStarGroup = false;
  for (const line of robots.split("\n")) {
    const [field = "", ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const key = field.trim().toLowerCase();
    if (key === "user-agent") {
      inStarGroup = value === "*";
    } else if (inStarGroup && (key === "allow" || key === "disallow")) {
      rules.push({ allow: key === "allow", pattern: value });
    }
  }
  return rules;
};

const patternMatches = (pattern: string, url: string): boolean => {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`, "u").test(url);
};

/**
 * RFC 9309 precedence: the longest matching rule wins; on a tie the allow
 * rule wins; no matching rule allows.
 */
const robotsAllows = (rules: readonly RobotsRule[], url: string): boolean => {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, url)) {
      continue;
    }
    if (
      best === null ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best?.allow ?? true;
};

const headIndexes = (url: `/${string}`): boolean => {
  const { pathname } = new URL(url, "https://crawl.invalid");
  const robots = createPublicLawHead({
    crawlAllowed: isPublicLawPathIndexable(pathname, true),
    path: url,
    title: "t",
    type: "website",
  }).meta.find((entry) => "name" in entry && entry.name === "robots");
  return (
    robots !== undefined &&
    "content" in robots &&
    robots.content.startsWith("index,")
  );
};

const robots = parseRobots(
  createRobotsTxt({
    publicKnowledgeCrawlAllowed: false,
    publicLawCrawlAllowed: true,
    publicToolsCrawlAllowed: false,
    seoIndexable: true,
  }),
);

const sitemapPaths = [
  ...createPublicLawStaticSitemapXml({
    publicLawIndexingEnabled: true,
  }).matchAll(/<loc>http:\/\/localhost:3000([^<]*)<\/loc>/gu),
].map((match) => match[1] ?? "");

const publicCountries = PUBLIC_CASE_LAW_PAGE_COUNTRIES.map(
  toCaseLawCountryParam,
);

/** Every law page shape, public and not, with and without a query. */
const sampleUrls = (country: string): `/${string}`[] => [
  `/law/${country}`,
  `/law/${country}/courts/nejvyssi-soud`,
  `/law/${country}/courts/nejvyssi-soud/2023`,
  `/law/${country}/courts/nejvyssi-soud/2023/05`,
  `/law/${country}/courts/nejvyssi-soud/2023/05/page/2`,
  `/law/${country}/courts/nejvyssi-soud/2023/05/17`,
  `/law/${country}/cases/nejvyssi-soud/21-cdo-1-2023`,
  `/law/${country}/statutes`,
  `/law/${country}/statutes?q=civil`,
  `/law/${country}/courts/nejvyssi-soud?page=2`,
  `/law?country=${country}`,
  `/law/cases?country=${country}&q=lease`,
];

describe("public law crawl invariants", () => {
  const urls = [
    "/law",
    "/law/coverage",
    "/law/cases",
    ...publicCountries.flatMap(sampleUrls),
    // Jurisdictions whose pages are not public stay invisible.
    ...["usa", "aut", "bra", "gbr"].flatMap(sampleUrls),
  ] as const satisfies readonly `/${string}`[];

  test.each(urls)("robots.txt and the page head agree on %s", (url) => {
    // `/law` itself redirects to a search URL; it is allowed so the redirect
    // can be followed, and its own head is never served.
    if (url === "/law") {
      return;
    }
    expect(robotsAllows(robots, url)).toBe(headIndexes(url));
    expect(isPublicLawUrlIndexable(url, true)).toBe(headIndexes(url));
  });

  test("every sitemap entry is allowed by robots.txt and indexed by its head", () => {
    expect(sitemapPaths.length).toBeGreaterThan(0);
    for (const path of sitemapPaths) {
      expect(path).not.toContain("?");
      expect(robotsAllows(robots, path)).toBe(true);
      expect(headIndexes(path as `/${string}`)).toBe(true);
    }
  });

  test("the sitemap lists every public jurisdiction's hub and nothing else's", () => {
    for (const country of publicCountries) {
      expect(sitemapPaths).toContain(`/law/${country}`);
    }
    for (const country of ["usa", "aut", "bra", "gbr"]) {
      expect(
        sitemapPaths.some((path) => path.startsWith(`/law/${country}`)),
      ).toBe(false);
    }
  });

  test("hub pages of a public jurisdiction are indexable; their query variants are not", () => {
    for (const country of publicCountries) {
      expect(
        robotsAllows(robots, `/law/${country}/courts/nejvyssi-soud/2023`),
      ).toBe(true);
      expect(robotsAllows(robots, `/law/${country}/statutes?q=x`)).toBe(false);
      expect(headIndexes(`/law/${country}/statutes?q=x`)).toBe(false);
    }
  });
});
