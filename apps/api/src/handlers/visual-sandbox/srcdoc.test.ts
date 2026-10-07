import { describe, expect, test } from "bun:test";
import { load } from "cheerio";

import { VISUAL_DATA_SCRIPT_ID } from "@stll/api-contract/generated-visual";
import { VISUAL_THEME_SCRIPT_ID } from "@stll/api-contract/visual-theme";
import { VISUAL_GUEST_MARKER_ATTRIBUTE } from "@stll/api-contract/visual-sandbox";

import { VISUAL_INNER_POLICY, visualOuterPolicy } from "./document";
import { sanitizeVisualHtml } from "./sanitize";
import {
  composeVisualDocument,
  escapeVisualJson,
  escapeVisualScript,
} from "./srcdoc";

const markup = sanitizeVisualHtml("<p>Timeline</p>").unwrap();

describe("visual document composition", () => {
  test("provides initial theme JSON before executable runtime without changing policy", () => {
    const theme = { appearance: "dark", variables: { "--foreground": "oklch(0.8 0.1 200)" } } as const;
    const $ = load(composeVisualDocument({ html: markup, data: {}, runtime: "void 0", policy: VISUAL_INNER_POLICY, theme }));
    const scripts = $("head script");
    expect(scripts.eq(1).attr("id")).toBe(VISUAL_THEME_SCRIPT_ID);
    expect(scripts.eq(1).attr("type")).toBe("application/json");
    expect(JSON.parse(scripts.eq(1).text())).toEqual(theme);
    expect(scripts.last().text()).toBe("void 0");
    expect($("meta[http-equiv=Content-Security-Policy]").attr("content")).toBe(VISUAL_INNER_POLICY);
  });

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
          html: markup,
          data: {},
          runtime: `const title=${encoded};`,
          policy: "default-src 'none'",
        }),
      );
      expect(document("head script:not([type])").text()).toBe(
        `const title=${encoded};`,
      );
      expect(document("body p").text()).toBe("Timeline");
    }
  });
  test("places the policy before all presentation markup", () => {
    const $ = load(
      composeVisualDocument({
        html: markup,
        data: {},
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
    expect($("html").attr(VISUAL_GUEST_MARKER_ATTRIBUTE)).toBe("");
    expect($("body p").text()).toBe("Timeline");
    expect($("head script:not([type])").text()).toBe("void 0");
    expect($("head").children().eq(1).attr("http-equiv")).toBe(
      "x-dns-prefetch-control",
    );
  });

  test("keeps policy attribute values intact and reserves ancestors for the response header", () => {
    for (const policy of [
      "default-src 'none'",
      'report-uri https://example.test/?a=1&b="<timeline>"',
    ]) {
      const $ = load(
        composeVisualDocument({
          html: markup,
          data: {},
          runtime: "void 0",
          policy,
        }),
      );
      expect(
        $("meta[http-equiv=Content-Security-Policy]").attr("content"),
      ).toBe(policy);
      expect($("meta[http-equiv=Content-Security-Policy]")).toHaveLength(1);
      expect($("body p").text()).toBe("Timeline");
    }
    const $ = load(
      composeVisualDocument({
        html: markup,
        data: {},
        runtime: "void 0",
        policy: VISUAL_INNER_POLICY,
      }),
    );
    expect(
      $("meta[http-equiv=Content-Security-Policy]").attr("content"),
    ).not.toContain("frame-ancestors");
    expect(visualOuterPolicy(["https://web.example.test"])).toContain(
      "frame-ancestors https://web.example.test",
    );
  });

  test("serializes embedded JSON without markup delimiters", () => {
    const value = { text: "<p>Timeline & dates</p>" };
    const json = escapeVisualJson(value);
    expect(json).not.toContain("<");
    expect(json).not.toContain(">");
    expect(JSON.parse(json)).toEqual(value);
  });

  test("provides inert data before the first executable runtime script", () => {
    const data = { caption: "Timeline & years" };
    const $ = load(
      composeVisualDocument({
        html: markup,
        data,
        runtime: "void 0",
        policy: "default-src 'none'",
      }),
    );
    const scripts = $("head script");
    expect(scripts).toHaveLength(2);
    expect(scripts.first().attr("type")).toBe("application/json");
    expect(scripts.first().attr("id")).toBe(VISUAL_DATA_SCRIPT_ID);
    expect(JSON.parse(scripts.first().text())).toEqual(data);
    expect(scripts.last().attr("type")).toBeUndefined();
    expect(scripts.last().text()).toBe("void 0");
  });
});
