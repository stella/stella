import { describe, expect, test } from "bun:test";
import { load } from "cheerio";

import { createHtmlSanitizer } from "./sanitize-html";

const sanitize = createHtmlSanitizer({
  allowedTags: new Set(["a", "p", "strong"]),
  allowedAttrs: { a: new Set(["href"]) },
  allowedHrefSchemes: new Set(["https:", "mailto:"]),
});

describe("HTML allowlist", () => {
  test("preserves formatting and unwraps other containers", () => {
    expect(
      sanitize('<section><p class="extra"><strong>text</strong></p></section>'),
    ).toBe("<p><strong>text</strong></p>");
  });

  test("removes active elements with their content and event attributes", () => {
    expect(
      sanitize(
        '<script>hidden</script><iframe>hidden</iframe><p onclick="test()">visible</p>',
      ),
    ).toBe("<p>visible</p>");
  });

  test("validates decoded hrefs and preserves safe query parameters", () => {
    const $ = load(
      sanitize('<a href="https://example.test/?a=1&amp;b=2">link</a>'),
    );
    expect($("a").attr("href")).toBe("https://example.test/?a=1&b=2");
    expect(sanitize('<a href="&#106;avascript:test()">link</a>')).toBe(
      "<a>link</a>",
    );
  });

  test("supports explicit local-link policy", () => {
    const local = createHtmlSanitizer({
      allowedTags: new Set(["a"]),
      allowedAttrs: { a: new Set(["href"]) },
      allowedHrefSchemes: new Set(["https:"]),
      isAllowedLocalHref: (href) =>
        href.startsWith("resource:") && href.length > 9,
    });
    expect(local('<a href="resource:123">reference</a>')).toBe(
      '<a href="resource:123">reference</a>',
    );
    expect(local('<a href="resource:">empty</a>')).toBe("<a>empty</a>");
  });
});
