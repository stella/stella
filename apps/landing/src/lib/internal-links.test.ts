import { describe, expect, test } from "bun:test";

import {
  extractPageHrefs,
  extractSiteUrls,
  findLinkIssues,
  pageUrlPath,
} from "./internal-links";

const site = new URL("https://stll.app");
const files = new Set([
  "index.html",
  "404.html",
  "docs/index.html",
  "cs/product/agent/index.html",
  "llms.txt",
]);

const issuesFor = (html: string, page = "index.html") =>
  findLinkIssues({ site, files, documents: new Map([[page, html]]) });

describe("extractPageHrefs", () => {
  test("reads anchors and page-naming link relations, not loaded resources", () => {
    expect(
      extractPageHrefs(
        '<link rel="stylesheet" href="/_astro/a.css"><link rel="canonical" href="https://stll.app/docs/"><a class="x" href="/a?b=1&amp;c=2">x</a><a name="top">',
      ),
    ).toEqual(["https://stll.app/docs/", "/a?b=1&c=2"]);
  });
});

describe("extractSiteUrls", () => {
  test("reads same-site URLs out of Markdown and plain text", () => {
    expect(
      extractSiteUrls(
        "- [Security](https://stll.app/security): posture.\nSee https://stll.app/llms.txt. App: https://my.stll.app <https://stll.app/>",
        site,
      ),
    ).toEqual([
      "https://stll.app/security",
      "https://stll.app/llms.txt",
      "https://stll.app/",
    ]);
  });
});

describe("pageUrlPath", () => {
  test("maps a built file to the URL it answers at", () => {
    expect(pageUrlPath("index.html")).toBe("/");
    expect(pageUrlPath("cs/product/agent/index.html")).toBe(
      "/cs/product/agent/",
    );
    expect(pageUrlPath("404.html")).toBe("/404.html");
  });
});

describe("findLinkIssues", () => {
  test("accepts built pages, files, fragments, and other origins", () => {
    expect(
      issuesFor(
        '<a href="/docs/#intro"></a><a href="/llms.txt"></a><a href="#top"></a><a href="https://github.com/stella"></a><a href="mailto:contact@stll.app"></a>',
      ),
    ).toEqual([]);
  });

  test("flags a slashless link to a built page, relative or absolute", () => {
    expect(
      issuesFor(
        '<a href="/docs"></a><link rel="alternate" href="https://stll.app/cs/product/agent">',
      ),
    ).toEqual([
      { type: "missing-trailing-slash", page: "/", href: "/docs" },
      {
        type: "missing-trailing-slash",
        page: "/",
        href: "https://stll.app/cs/product/agent",
      },
    ]);
  });

  test("resolves relative hrefs against the page URL", () => {
    expect(
      issuesFor(
        '<a href="../"></a><a href="../agent"></a>',
        "cs/product/agent/index.html",
      ),
    ).toEqual([
      { type: "not-built", page: "/cs/product/agent/", href: "../" },
      {
        type: "missing-trailing-slash",
        page: "/cs/product/agent/",
        href: "../agent",
      },
    ]);
  });

  test("checks shipped text files by their absolute URLs", () => {
    expect(
      issuesFor("[Docs](https://stll.app/docs) and /press", "index.md"),
    ).toEqual([
      {
        type: "missing-trailing-slash",
        page: "/index.md",
        href: "https://stll.app/docs",
      },
    ]);
  });

  test("flags a link to a URL the build did not write", () => {
    expect(issuesFor('<a href="/blog/"></a><a href="/press"></a>')).toEqual([
      { type: "not-built", page: "/", href: "/blog/" },
      { type: "not-built", page: "/", href: "/press" },
    ]);
  });
});
