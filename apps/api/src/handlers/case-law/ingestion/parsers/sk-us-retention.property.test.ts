import { expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

import {
  expectMarkerRetention,
  injectMarkupMarkers,
  markerPlan,
} from "./marker-injection.test-helper";
import { parseSkUsDocumentXhtml } from "./sk-us";

const shapes = fc.array(
  fc.constantFrom(
    "<div>Text pred blokom.<p>Vnorený odsek.</p>Text za blokom.</div>",
    "<h2>Nadpis oddielu</h2><blockquote>Citovaný text.</blockquote>",
    "<ul>Text pred zoznamom.<li>Prvá položka.</li>Text medzi položkami.<li>Druhá položka.</li>Text za zoznamom.</ul>",
    "<ol><li><p>Vnorená položka.</p>Ďalší text.</li></ol>",
    "<table><tr><th>Nadpis bunky</th><td>Text pred odsekom.<p>Vnorená bunka.</p>Text za odsekom.</td></tr></table>",
    "<table><tr><td>Vonkajšia bunka.<table><tr><td>Vnútorná bunka.</td></tr></table>Koniec bunky.</td></tr></table>",
    "<div id='_ftn1'><p>Poznámka pod čiarou.</p></div>",
    "<p><span style='font-size: 12px'>Prvý</span> <span style='font-size: 13px'><b>druhý</b> <i>tretí</i> &amp; &#382;ltý.</span></p>",
    "<p><span>Text pred zalomením.<br> <br>Text za zalomením.<br><br><br>Koniec.</span></p>",
    "<p>  &#160; </p>",
  ),
  { minLength: 1, maxLength: 8 },
);
const wrappers = fc.array(fc.constantFrom("div", "section", "blockquote"), {
  maxLength: 3,
});

test(
  "Slovak constitutional body markers retain their source order",
  () => {
    assertProperty(
      "Slovak constitutional body markers retain their source order",
      fc.property(
        markerPlan,
        shapes,
        wrappers,
        (plan, fragments, ancestors) => {
          const fixture = cheerio.load(
            `<html><body><p class="fixture-title"><span style="font-size: 18px">UZNESENIE</span></p><main><p><span style="font-size: 12px">Ústavný súd rozhodol: Návrh sa zamieta.</span></p><p>Odôvodnenie: Posúdenie návrhu.</p>${fragments.join("")}<span class="fixture-hidden" style="color: #000000; background-color: #000000">hiddenqzexcluded</span><script>scriptqzexcluded</script><style>styleqzexcluded</style></main><p class="fixture-footer">42</p></body></html>`,
          );
          for (const tag of ancestors) {
            fixture("main").wrapInner(`<${tag}></${tag}>`);
          }
          const injected = injectMarkupMarkers({
            source: fixture.html(),
            selector: "main",
            excludedSelector: ".fixture-hidden, script, style",
            plan,
          });
          const parsed = parseSkUsDocumentXhtml({
            xhtml: injected.source,
            caseNumber: "property-fixture",
            ecli: undefined,
            court: "fixture court",
            decisionDate: undefined,
            decisionType: "uznesenie",
            documentUrl: "https://example.test/document",
          });
          expectMarkerRetention(parsed.fulltext, injected.markers);
          for (const excluded of [
            "hiddenqzexcluded",
            "scriptqzexcluded",
            "styleqzexcluded",
          ]) {
            expect(parsed.fulltext).not.toContain(excluded);
            expect(JSON.stringify(parsed.documentAst.blocks)).not.toContain(
              excluded,
            );
          }
          expect(parsed.fulltext).not.toMatch(/^\s*42\s*$/mu);
          // Hidden text is replaced by the documented anonymization placeholder.
          injected.$(".fixture-hidden").text("anonymizované");
          injected.$("script, style, .fixture-footer").remove();
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
