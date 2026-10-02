import { expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

import { parseNsDecisionHtml } from "./cz-ns";
import {
  expectMarkerRetention,
  injectMarkupMarkers,
  markerPlan,
} from "./marker-injection.test-helper";

const shapes = fc.array(
  fc.constantFrom(
    "<div>Text před blokem.<p>Text uvnitř bloku.</p>Text za blokem.</div>",
    "<h2>Nadpis oddílu</h2><blockquote>Citovaný text.</blockquote>",
    "<ul>Text před seznamem.<li>První položka.</li>Text mezi položkami.<li>Druhá položka.</li>Text za seznamem.</ul>",
    "<ol><li><p>Vnořená položka.</p>Další text.</li></ol>",
    "<table><caption>Popisek tabulky</caption><tr><th>Nadpis buňky</th><td>Text před odstavcem.<p>Vnořená buňka.</p>Text za odstavcem.</td></tr></table>",
    "<table><tr><td>Vnější buňka.<table><tr><td>Vnitřní buňka.</td></tr></table>Konec buňky.</td></tr></table>",
    "<div id='_ftn1'><p>Poznámka pod čarou.</p></div>",
    "<p><b>První</b> <i>druhý</i><span> třetí &amp; čtvrtý &#382;luťoučký.</span></p>",
    "<p>Text před zalomením.<br> <br>Text za zalomením.<br><br><br>Konec.</p>",
    "<p>  &#160; </p>",
  ),
  { minLength: 1, maxLength: 8 },
);
const wrappers = fc.array(fc.constantFrom("div", "section", "blockquote"), {
  maxLength: 3,
});
const id = "Czech supreme body markers retain their source order";

test(
  id,
  () => {
    assertProperty(
      id,
      fc.property(
        markerPlan,
        shapes,
        wrappers,
        (plan, fragments, ancestors) => {
          let body = `<p>Nejvyšší soud rozhodl takto: Návrh se zamítá.</p><p>Odůvodnění: Posouzení návrhu.</p>${fragments.join("")}`;
          for (const tag of ancestors) {body = `<${tag}>${body}</${tag}>`;}
          const fixture = cheerio.load(
            `<html><body><table id="box-table-a"><tr><td>Soud:</td><td>metadataqzexcluded</td></tr></table><p class="fixture-title" align="center">ROZSUDEK</p>${body}<script>scriptqzexcluded</script><style>styleqzexcluded</style></body></html>`,
          );
          const injected = injectMarkupMarkers({
            source: fixture.html(),
            selector: "body",
            excludedSelector: "#box-table-a, .fixture-title, script, style",
            plan,
          });
          const parsed = parseNsDecisionHtml({
            documentId: "property-fixture",
            webUrl: "https://example.test/detail",
            printUrl: "https://example.test/print",
            webHtml: "",
            printHtml: injected.source,
          });
          expectMarkerRetention(parsed.fulltext, injected.markers);
          for (const excluded of [
            "metadataqzexcluded",
            "scriptqzexcluded",
            "styleqzexcluded",
          ]) {
            expect(parsed.fulltext).not.toContain(excluded);
            expect(JSON.stringify(parsed.documentAst.blocks)).not.toContain(
              excluded,
            );
          }
          injected.$("#box-table-a, script, style").remove();
          expect(
            validateAst(injected.$.html(), parsed.documentAst.blocks).ok,
          ).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  },
  propertyTestTimeout(30_000),
);
