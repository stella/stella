import { expect, test } from "bun:test";

import { findIconInHtml } from "@/api/handlers/mcp-connectors/icons";

import fixtures from "./fixtures/icon-discovery.json";

// Expected URLs were captured with the original cheerio.load extractor.
for (const { name, html, expected } of fixtures) {
  test(`icon discovery preserves ${name}`, () => {
    expect(
      findIconInHtml({ html, rootUrl: new URL("https://example.com/") }),
    ).toBe(expected);
  });
}
