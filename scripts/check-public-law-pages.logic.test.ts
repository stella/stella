import { describe, expect, test } from "bun:test";

import {
  buildReport,
  checkPage,
  filterCountryShards,
  headerAllowsIndexing,
  isUndatedShardUrl,
  parseSitemapLocs,
  readDecisionMetadata,
  readRobotsMeta,
  renderMarkdown,
  shuffled,
  visibleText,
} from "./check-public-law-pages.logic";

const BODY = "Synthetic reasoning sentence about a contract. ".repeat(40);

const jsonLd = (overrides: Record<string, unknown> = {}) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "LegalDocument",
    name: "1 Cdo 1/2020",
    publisher: { "@type": "Organization", name: "Synthetic Court" },
    datePublished: "2020-01-02",
    ...overrides,
  })}</script>`;

const page = (
  options: {
    robots?: string;
    body?: string;
    ld?: string;
    h1?: boolean;
    chrome?: string;
  } = {},
) =>
  `<!doctype html><html><head><title>t</title>${
    options.robots === undefined
      ? ""
      : `<meta name="robots" content="${options.robots}">`
  }${options.ld ?? jsonLd()}<script>window.x = "${"s".repeat(5000)}"</script></head><body>${
    options.h1 === false ? "" : "<h1>Decision</h1>"
  }<main><nav>${options.chrome ?? ""}</nav><article lang="sk">${
    options.body ?? BODY
  }</article></main></body></html>`;

const observe = (
  html: string,
  status = 200,
  extra: { xRobotsTag?: string | null; dateRequired?: boolean } = {},
) => ({
  url: "https://example.test/law/svk/cases/c/s",
  status,
  contentType: "text/html; charset=utf-8",
  xRobotsTag: extra.xRobotsTag ?? null,
  dateRequired: extra.dateRequired ?? true,
  html,
});

describe("visibleText", () => {
  test("drops scripts, styles and tags", () => {
    expect(
      visibleText(
        "<style>a{}</style><script>var x=1</script><p>Hello&nbsp;<b>world</b></p>",
      ),
    ).toBe("Hello world");
  });
});

describe("readRobotsMeta", () => {
  test("reads noindex and absence", () => {
    expect(
      readRobotsMeta('<meta name="robots" content="noindex,nofollow">'),
    ).toEqual({ present: true, noindex: true });
    expect(
      readRobotsMeta('<meta content="index,follow" name="robots">'),
    ).toEqual({ present: true, noindex: false });
    expect(readRobotsMeta('<meta name="robots" content="none">')).toEqual({
      present: true,
      noindex: true,
    });
    expect(readRobotsMeta("<p>none</p>")).toEqual({
      present: false,
      noindex: false,
    });
  });

  test("applies a noindex tag in either order", () => {
    const index = '<meta name="robots" content="index,follow">';
    const noindex = '<meta name="robots" content="noindex">';
    for (const html of [index + noindex, noindex + index]) {
      expect(readRobotsMeta(html)).toEqual({ present: true, noindex: true });
    }
  });
});

describe("readDecisionMetadata", () => {
  test("reads case number, court and date from JSON-LD", () => {
    expect(readDecisionMetadata(page())).toEqual({
      caseNumber: "1 Cdo 1/2020",
      court: "Synthetic Court",
      date: "2020-01-02",
    });
  });

  test("tolerates malformed blocks", () => {
    expect(
      readDecisionMetadata('<script type="application/ld+json">{nope</script>'),
    ).toEqual({ caseNumber: null, court: null, date: null });
  });
});

describe("checkPage", () => {
  test("passes a complete noindex page when noindex is expected", () => {
    expect(
      checkPage(observe(page({ robots: "noindex,nofollow" })), "noindex")
        .failed,
    ).toEqual([]);
  });

  test("passes an indexable page when indexable is expected", () => {
    expect(
      checkPage(observe(page({ robots: "index,follow" })), "indexable").failed,
    ).toEqual([]);
  });

  test("flags robots mismatches both ways", () => {
    expect(
      checkPage(observe(page({ robots: "index" })), "noindex").failed,
    ).toContain("robots");
    expect(
      checkPage(observe(page({ robots: "noindex" })), "indexable").failed,
    ).toContain("robots");
  });

  test("flags a non-200 and skips content checks", () => {
    expect(checkPage(observe("", 404), "noindex").failed).toEqual(["http-200"]);
  });

  test("flags a client-rendered shell", () => {
    const shell =
      '<html><body><div id="root"></div><script>x</script></body></html>';
    expect(checkPage(observe(shell), "noindex").failed).toEqual(
      expect.arrayContaining(["server-rendered", "decision-text", "metadata"]),
    );
  });

  test("does not count page chrome as decision text", () => {
    const result = checkPage(
      observe(
        page({
          robots: "noindex",
          chrome: "Menu item. ".repeat(200),
          body: "",
        }),
      ),
      "noindex",
    );
    expect(result.failed).toEqual(["decision-text"]);
    expect(result.textChars).toBe(0);
  });

  test("flags trivial decision text", () => {
    expect(
      checkPage(observe(page({ body: "A".repeat(400) })), "noindex").failed,
    ).toEqual(expect.arrayContaining(["decision-text"]));
  });

  test("indexable needs both the meta tag and the header to allow indexing", () => {
    const html = page({ robots: "index,follow" });
    expect(
      checkPage(observe(html, 200, { xRobotsTag: "noindex" }), "indexable")
        .failed,
    ).toContain("robots");
    expect(
      checkPage(observe(html, 200, { xRobotsTag: "noindex" }), "noindex")
        .failed,
    ).toEqual([]);
    expect(
      checkPage(observe(html, 200, { xRobotsTag: null }), "noindex").failed,
    ).toContain("robots");
    expect(headerAllowsIndexing(null)).toBe(true);
    expect(headerAllowsIndexing("NOINDEX, nofollow")).toBe(false);
  });

  test("does not require a date on a page of the undated shard", () => {
    const undated = page({
      robots: "noindex",
      ld: jsonLd({ datePublished: undefined }),
    });
    expect(
      checkPage(observe(undated, 200, { dateRequired: false }), "noindex")
        .failed,
    ).toEqual([]);
    expect(checkPage(observe(undated), "noindex").failed).toContain("metadata");
    expect(isUndatedShardUrl("/sitemaps/law-cases/svk/undated/00.xml")).toBe(
      true,
    );
    expect(isUndatedShardUrl("/sitemaps/law-cases/svk/2024/01.xml")).toBe(
      false,
    );
  });

  test("flags missing metadata", () => {
    expect(
      checkPage(
        observe(page({ ld: jsonLd({ publisher: undefined }) })),
        "noindex",
      ).failed,
    ).toContain("metadata");
  });
});

describe("report", () => {
  const good = checkPage(observe(page({ robots: "noindex" })), "noindex");
  const bad = {
    ...checkPage(observe("", 500), "noindex"),
    url: "https://example.test/bad",
  };

  test("passes only when every check passes and nothing failed to fetch", () => {
    const base = {
      baseUrl: "https://example.test",
      country: "svk",
      expectedRobots: "noindex",
      sampleSize: 2,
    } as const;
    expect(
      buildReport({ ...base, fetchErrors: [], results: [good] }).pass,
    ).toBe(true);
    expect(
      buildReport({ ...base, fetchErrors: [], results: [good, bad] }).pass,
    ).toBe(false);
    expect(
      buildReport({ ...base, fetchErrors: ["u"], results: [good] }).pass,
    ).toBe(false);
    expect(buildReport({ ...base, fetchErrors: [], results: [] }).pass).toBe(
      false,
    );
  });

  test("renders failing URLs in markdown", () => {
    const markdown = renderMarkdown(
      buildReport({
        baseUrl: "https://example.test",
        country: "svk",
        expectedRobots: "noindex",
        sampleSize: 2,
        fetchErrors: [],
        results: [good, bad],
      }),
    );
    expect(markdown).toContain("Result: FAIL");
    expect(markdown).toContain("- https://example.test/bad");
  });
});

describe("sitemap helpers", () => {
  test("parses locs and filters country shards", () => {
    const xml =
      "<urlset><loc>https://a.test/sitemaps/law-cases/svk/2024/01.xml</loc><loc> https://a.test/sitemaps/law-cases/cze/2024/01.xml </loc></urlset>";
    const locs = parseSitemapLocs(xml);
    expect(locs).toHaveLength(2);
    expect(filterCountryShards(locs, "SVK")).toEqual([
      "https://a.test/sitemaps/law-cases/svk/2024/01.xml",
    ]);
  });

  test("shuffled keeps the same items", () => {
    expect(shuffled([1, 2, 3, 4], () => 0.5).toSorted()).toEqual([1, 2, 3, 4]);
  });
});
