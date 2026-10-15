import { expect, test } from "bun:test";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
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

/** Markup mixing text, comments, CDATA, scripts and styles at any depth. */
const htmlTree: fc.Arbitrary<string> = fc.letrec<{ node: string }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 4, depthSize: "small" },
    fc.constantFrom("a", "č ", " ", "\n", "&amp;", "x<br>y"),
    fc.constant("<!-- note -->"),
    fc.constant("<![CDATA[cdata]]>"),
    fc
      .tuple(
        fc.constantFrom("div", "p", "span", "td", "script", "style", "svg"),
        fc.array(tie("node"), { maxLength: 4 }),
      )
      .map(([tag, children]) => `<${tag}>${children.join("")}</${tag}>`),
  ),
})).node;

test("HTML text reads exactly what clone-and-remove reads", () => {
  // The reading before the walk replaced it: a clone with every script and
  // style removed. The walk must agree with it on every tree, including the
  // root being a script or style itself.
  const cloneAndRemove = (el: cheerio.Cheerio<AnyNode>): string => {
    const copy = el.clone();
    copy.find("script, style").remove();
    return copy.not("script, style").text();
  };
  assertProperty(
    "HTML text reads exactly what clone-and-remove reads",
    fc.property(fc.array(htmlTree, { maxLength: 5 }), (nodes) => {
      const $ = cheerio.load(`<body>${nodes.join("")}</body>`);
      const original = $.html();
      for (const selection of [
        $("body"),
        $("body").children(),
        $("body *"),
        $.root(),
      ]) {
        expect(visibleHtmlText(selection)).toBe(cloneAndRemove(selection));
      }
      expect($.html()).toBe(original);
    }),
    { numRuns: 200 },
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
