import { describe, expect, test } from "bun:test";
import { load } from "cheerio";

import {
  composeVisualDocument,
  escapeVisualJson,
  escapeVisualScript,
} from "./srcdoc";

describe("visual document composition", () => {
  test("preserves composer string values when embedding bundled scripts", () => {
    for (const value of [
      "</script>",
      "</SCRIPT>",
      "</ScRiPt >",
      "<!--",
      "<p>Timeline</p>",
    ]) {
      const encoded = escapeVisualScript(JSON.stringify(value));
      expect(JSON.parse(encoded)).toBe(value);
      expect(encoded).not.toMatch(/<\/script|<!--/iu);
      const document = load(
        composeVisualDocument({
          html: "<p>Timeline</p>",
          runtime: `const title=${encoded};`,
          policy: "default-src 'none'",
        }),
      );
      expect(document("head script").text()).toBe(`const title=${encoded};`);
      expect(document("body p").text()).toBe("Timeline");
    }
  });
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
