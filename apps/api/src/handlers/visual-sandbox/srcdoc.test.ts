import { describe, expect, test } from "bun:test";
import { load } from "cheerio";

import { composeVisualDocument, escapeVisualJson } from "./srcdoc";

describe("visual document composition", () => {
  test("places the policy before all presentation markup", () => {
    const $ = load(
      composeVisualDocument({
        html: "<p>Timeline</p>",
        runtime: "void 0",
        policy: "default-src 'none'",
      }),
    );
    expect($("head").children().first().attr("http-equiv")).toBe(
      "Content-Security-Policy",
    );
    expect($("head").children().first().attr("content")).toBe(
      "default-src 'none'",
    );
    expect($("body p").text()).toBe("Timeline");
    expect($("head script").text()).toBe("void 0");
    expect($("head").children().eq(1).attr("http-equiv")).toBe(
      "x-dns-prefetch-control",
    );
  });

  test("serializes embedded JSON without markup delimiters", () => {
    const value = { text: "<p>Timeline & dates</p>" };
    const json = escapeVisualJson(value);
    expect(json).not.toContain("<");
    expect(json).not.toContain(">");
    expect(JSON.parse(json)).toEqual(value);
  });
});
