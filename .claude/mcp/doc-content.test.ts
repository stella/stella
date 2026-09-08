import { describe, expect, test } from "bun:test";

import {
  formatFetchDocsOutput,
  MAX_FETCH_DOC_CHARS,
  readableDocText,
  resolveMarkdownDocUrl,
} from "./doc-content";

describe("documentation content", () => {
  test("rewrites only known provider page paths while preserving URL state", () => {
    expect(
      resolveMarkdownDocUrl(
        "https://tanstack.com/query/latest/docs/framework/react/guides/query-options?version=5#example",
      ),
    ).toBe(
      "https://tanstack.com/query/latest/docs/framework/react/guides/query-options.md?version=5#example",
    );
    expect(
      resolveMarkdownDocUrl(
        "https://oxc.rs/docs/guide/usage/linter/js-plugins.html?lang=en#setup",
      ),
    ).toBe(
      "https://oxc.rs/docs/guide/usage/linter/js-plugins.md?lang=en#setup",
    );

    const stableUrls = [
      "https://tanstack.com/llms.txt",
      "https://tanstack.com/query/latest/llms.txt?scope=react#guides",
      "https://tanstack.com/query/latest/docs/framework/react/index",
      "https://tanstack.com/query/latest/docs/framework/react/overview.md",
      "https://oxc.rs/docs/index.html",
      "https://oxc.rs/docs/guide/usage/linter/js-plugins.md",
      "https://oxc.rs/api/data",
    ];

    for (const url of stableUrls) {
      expect(resolveMarkdownDocUrl(url)).toBe(url);
    }
  });

  test("rejects HTML identified by its media type or document marker", () => {
    expect(() =>
      readableDocText({
        contentType: "text/html; charset=utf-8",
        text: "<main>Documentation</main>",
        url: "https://docs.example/page",
      }),
    ).toThrow("returned HTML, which is not sent to the model");
    expect(() =>
      readableDocText({
        contentType: "text/plain",
        text: `\uFEFF<?xml version="1.0"?><!-- ${"generated".repeat(400)} -->\n<!doctype html><html><body>Documentation</body></html>`,
        url: "https://docs.example/page",
      }),
    ).toThrow("Use search_docs");
  });

  test("returns Markdown unchanged", () => {
    const markdown = "# Query options\n\nUse `queryOptions`.";
    expect(
      readableDocText({
        contentType: "text/markdown; charset=utf-8",
        text: markdown,
        url: "https://docs.example/page.md",
      }),
    ).toBe(markdown);
  });

  test("bounds full fetch output and provides the accepted next call", () => {
    const url = "https://docs.example/page.md";
    const output = formatFetchDocsOutput({
      text: "a".repeat(MAX_FETCH_DOC_CHARS + 1),
      url,
    });

    expect(output.length).toBeLessThanOrEqual(MAX_FETCH_DOC_CHARS);
    expect(output).toContain(
      `[Response truncated at ${MAX_FETCH_DOC_CHARS} characters.`,
    );
    expect(output).toContain(
      `fetch_doc_chunks with {"url":"${url}","query":"the specific API or behavior you need","maxChunks":3}`,
    );

    const longUrl = `https://docs.example/${"segment".repeat(MAX_FETCH_DOC_CHARS)}`;
    const longUrlOutput = formatFetchDocsOutput({
      text: "a".repeat(MAX_FETCH_DOC_CHARS + 1),
      url: longUrl,
    });
    expect(longUrlOutput.length).toBeLessThanOrEqual(MAX_FETCH_DOC_CHARS);
    expect(longUrlOutput).toEndWith(
      "Call fetch_doc_chunks with the same URL and a specific query.]",
    );
  });
});
