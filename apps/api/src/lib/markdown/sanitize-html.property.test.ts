import { describe, expect, test } from "bun:test";
import { load } from "cheerio";
import { isTag } from "domhandler";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { createHtmlSanitizer } from "./sanitize-html";

const sanitize = createHtmlSanitizer({
  allowedTags: new Set(["a", "b", "br", "p", "strong", "em", "blockquote"]),
  allowedAttrs: { a: new Set(["href"]) },
  allowedHrefSchemes: new Set(["https:", "mailto:", "tel:"]),
});
const href = fc.oneof(
  fc.string({ maxLength: 100 }),
  fc
    .tuple(
      fc.constantFrom("javascript", "vbscript", "data", "https", "mailto"),
      fc.constantFrom("", "\t", "\n", "&#9;", "&#x0a;"),
      fc.boolean(),
    )
    .map(([scheme, gap, upper]) => {
      const value = `${scheme.slice(0, 2)}${gap}${scheme.slice(2)}:test()`;
      return upper ? value.toUpperCase() : value;
    }),
);
const fragment = fc.oneof(
  fc.string({ maxLength: 200 }),
  href.map((value) => `<a href="${value}" onfocus="test()">link</a>`),
  fc.constantFrom(
    '<ScRiPt>test()</ScRiPt><p ONCLICK="test()">text</p>',
    '<svg><a href="&#106;avascript:test()">link</a></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=test()>">',
    '<p><b><a href="https://example.test/?a=1&amp;b=2">link</p></a></b>',
    '<svg><foreignObject><p onclick="test()">text</p></foreignObject></svg>',
  ),
);
const html = fc
  .array(fragment, { maxLength: 8 })
  .map((parts) => parts.join(""));

describe("HTML allowlist properties", () => {
  test(
    "reparsed output is free of active content",
    () => {
      fc.assert(
        fc.property(html, (input) => {
          const $ = load(sanitize(input));
          expect($("script").length).toBe(0);
          $("*").each((_, node) => {
            if (!isTag(node)) {
              return;
            }
            for (const [name, value] of Object.entries(node.attribs)) {
              expect(name.toLowerCase().startsWith("on")).toBe(false);
              if (name !== "href") {
                continue;
              }
              expect(URL.canParse(value, "https://example.test")).toBe(true);
              expect(["https:", "mailto:", "tel:"]).toContain(
                new URL(value, "https://example.test").protocol,
              );
            }
          });
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "sanitizing reaches a fixed point",
    () => {
      fc.assert(
        fc.property(html, (input) => {
          const once = sanitize(input);
          expect(sanitize(once)).toBe(once);
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );
});
