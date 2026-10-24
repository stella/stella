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
  runPublicLawCheck,
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
    expect(shuffled([1, 2, 3, 4], () => 0.5).toSorted((a, b) => a - b)).toEqual(
      [1, 2, 3, 4],
    );
  });
});

describe("public law fetch failures", () => {
  const baseUrl = "https://deployment.test";
  const shardPath = "/sitemaps/law-cases/svk/2024/01.xml";
  const shardUrl = `${baseUrl}${shardPath}`;
  const indexXml = `<sitemapindex><loc>https://canonical.test${shardPath}</loc></sitemapindex>`;
  const response = (
    body: string,
    status = 200,
    contentType = "application/xml",
  ) => new Response(body, { headers: { "content-type": contentType }, status });
  const run = async (
    fetch: (url: string) => Promise<Response>,
    sampleSize = 1,
  ) =>
    await runPublicLawCheck({
      baseUrl,
      country: "svk",
      expectedRobots: "noindex",
      fetch,
      random: () => 0,
      sampleSize,
    });

  test("explains a missing sitemap index", async () => {
    const result = await run(async () => response("missing", 404));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        step: "sitemap index",
        status: 404,
        url: `${baseUrl}/sitemaps/law.xml`,
      });
      expect(result.error.message).toContain(
        `sitemap index fetch failed at ${baseUrl}/sitemaps/law.xml (HTTP 404)`,
      );
    }
  });

  test("explains a missing country shard", async () => {
    const result = await run(async (url) =>
      url.endsWith("/sitemaps/law.xml")
        ? response(indexXml)
        : response("missing", 404),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        step: "country shard",
        status: 404,
        url: shardUrl,
      });
      expect(result.error.message).toBe(
        `country svk has no sitemap shard at ${shardUrl} (HTTP 404): is the jurisdiction pages_public on this deployment?`,
      );
    }
  });

  test("reports an unavailable country shard without missing-shard guidance", async () => {
    const result = await run(async (url) =>
      url.endsWith("/sitemaps/law.xml")
        ? response(indexXml)
        : response("unavailable", 503),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(
        `country shard fetch failed at ${shardUrl} (HTTP 503)`,
      );
      expect(result.error.message).not.toContain("pages_public");
    }
  });

  test("reports a country shard timeout without missing-shard guidance", async () => {
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    const result = await run(async (url) => {
      if (url.endsWith("/sitemaps/law.xml")) {
        return response(indexXml);
      }
      throw timeout;
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        cause: timeout,
        step: "country shard",
        url: shardUrl,
      });
      expect(result.error.message).toBe(
        `country shard fetch failed at ${shardUrl}: The operation timed out`,
      );
      expect(result.error.message).not.toContain("pages_public");
    }
  });

  test("reports a failed page while checking the remaining sample", async () => {
    const goodUrl = "https://canonical.test/law/svk/good";
    const badUrl = "https://canonical.test/law/svk/bad";
    const requested: string[] = [];
    const result = await run(async (url) => {
      requested.push(url);
      if (url.endsWith("/sitemaps/law.xml")) {
        return response(indexXml);
      }
      if (url === shardUrl) {
        return response(
          `<urlset><loc>${goodUrl}</loc><loc>${badUrl}</loc></urlset>`,
        );
      }
      if (url.endsWith("/bad")) {
        return response("unavailable", 503, "text/html");
      }
      return response(page({ robots: "noindex" }), 200, "text/html");
    }, 2);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.report.pass).toBe(false);
      expect(result.value.report.checked).toBe(1);
      expect(result.value.report.fetchErrors).toEqual([
        `page sample fetch failed at ${baseUrl}/law/svk/bad (HTTP 503)`,
      ]);
      expect(renderMarkdown(result.value.report)).toContain(
        `- page sample fetch failed at ${baseUrl}/law/svk/bad (HTTP 503)`,
      );
    }
    expect(requested).toContain(`${baseUrl}/law/svk/good`);
    expect(requested).toContain(`${baseUrl}/law/svk/bad`);
  });

  test("reports a malformed sitemap location while checking the valid page", async () => {
    const goodUrl = "https://canonical.test/law/svk/good";
    const result = await run(async (url) => {
      if (url.endsWith("/sitemaps/law.xml")) {
        return response(indexXml);
      }
      if (url === shardUrl) {
        return response(
          `<urlset><loc>not a url</loc><loc>${goodUrl}</loc></urlset>`,
        );
      }
      return response(page({ robots: "noindex" }), 200, "text/html");
    }, 2);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.report.checked).toBe(1);
      expect(result.value.report.fetchErrors).toEqual([
        "sitemap location is not a URL: not a url",
      ]);
      expect(result.value.sampledUrls).toEqual([`${baseUrl}/law/svk/good`]);
    }
  });

  test("returns a passing report for successful fetches", async () => {
    const pageUrl = "https://canonical.test/law/svk/good";
    const result = await run(async (url) => {
      if (url.endsWith("/sitemaps/law.xml")) {
        return response(indexXml);
      }
      if (url === shardUrl) {
        return response(`<urlset><loc>${pageUrl}</loc></urlset>`);
      }
      return response(page({ robots: "noindex" }), 200, "text/html");
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.report).toMatchObject({ checked: 1, pass: true });
      expect(result.value.report.fetchErrors).toEqual([]);
      expect(result.value.sampledUrls).toEqual([`${baseUrl}/law/svk/good`]);
    }
  });
});
