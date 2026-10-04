import { expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  inlinesToPlainText,
  ownTableRows,
  visibleHtmlText,
  walkInlines,
} from "./shared-inlines";

test("HTML text excludes scripts and styles at every nesting depth", () => {
  assertProperty(
    "HTML text excludes scripts and styles at every nesting depth",
    fc.property(fc.integer({ min: 0, max: 8 }), (depth) => {
      let html =
        "Visible<script>scriptqzexcluded</script><style>styleqzexcluded</style>Tail";
      for (let i = 0; i < depth; i++) {
        html = `<div>${html}</div>`;
      }
      const $ = cheerio.load(html);
      const original = $.html();
      expect(visibleHtmlText($("body"))).toBe("VisibleTail");
      expect(inlinesToPlainText(walkInlines($, $("body")))).toBe("VisibleTail");
      expect($.html()).toBe(original);
    }),
    { numRuns: 20 },
  );
});

test("Table rows retain nested cell text exactly once", () => {
  assertProperty(
    "Table rows retain nested cell text exactly once",
    fc.property(
      fc.integer({ min: 1, max: 6 }),
      fc.constantFrom("tbody", "thead", "tfoot"),
      (depth, section) => {
        let html = "qzmarkerInner";
        for (let i = 0; i < depth; i++) {
          html = `<table><${section}><tr><td>Outer${html}Tail</td></tr></${section}></table>`;
        }
        const $ = cheerio.load(html);
        const rows = ownTableRows($("table").first());
        expect(rows.length).toBe(1);
        const text = rows
          .toArray()
          .map((row) =>
            $(row)
              .children("td, th")
              .toArray()
              .map((cell) => inlinesToPlainText(walkInlines($, $(cell))))
              .join(""),
          )
          .join("");
        expect(text.split("qzmarkerInner").length - 1).toBe(1);
        expect(text).toBe(visibleHtmlText($("table").first()));
      },
    ),
    { numRuns: 20 },
  );
});
