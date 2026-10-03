import { expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  validateAst,
  buildValidationHtml,
} from "@/api/lib/legal-search/parsers/validate-ast";

import { parseUsDecisionHtml } from "./cz-us";
import {
  expectMarkerRetention,
  injectMarkupMarkers,
  markerPlan,
} from "./marker-injection.test-helper";

const metadata = {
  caseNumber: "property-fixture",
  court: "fixture court",
  ecli: undefined,
  decisionDate: undefined,
  decisionType: undefined,
};
const shapes = fc.array(
  fc.constantFrom(
    "<div>Text před blokem.<p>Vnořený odstavec.</p>Text za blokem.</div>",
    "<h2>Nadpis oddílu</h2><blockquote>Citovaný text.</blockquote>",
    "<ul>Text před seznamem.<li>První položka.</li>Text mezi položkami.<li>Druhá položka.</li>Text za seznamem.</ul>",
    "<ol><li><p>Vnořená položka.</p>Další text.</li></ol>",
    "<table><tr><th>Nadpis buňky</th><td>Text před odstavcem.<p>Vnořená buňka.</p>Text za odstavcem.</td></tr></table>",
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

test(
  "Czech constitutional HTML body markers retain their source order",
  () => {
    assertProperty(
      "Czech constitutional HTML body markers retain their source order",
      fc.property(
        markerPlan,
        shapes,
        wrappers,
        (plan, fragments, ancestors) => {
          const fixture = cheerio.load(
            `<html><body><header>headerqzexcluded</header><span id="lblDecisionForm">NÁLEZ</span><div class="DocContent"><p>Ústavní soud rozhodl takto: Návrh se zamítá.</p><p>Odůvodnění: Posouzení návrhu.</p>${fragments.join("")}<script>scriptqzexcluded</script><style>styleqzexcluded</style></div><footer>footerqzexcluded</footer></body></html>`,
          );
          for (const tag of ancestors) {
            fixture(".DocContent").wrapInner(`<${tag}></${tag}>`);
          }
          const injected = injectMarkupMarkers({
            source: fixture.html(),
            selector: ".DocContent",
            excludedSelector: "script, style",
            plan,
          });
          const parsed = parseUsDecisionHtml({
            ...metadata,
            html: injected.source,
          });
          expectMarkerRetention(parsed.fulltext, injected.markers);
          for (const excluded of [
            "headerqzexcluded",
            "footerqzexcluded",
            "scriptqzexcluded",
            "styleqzexcluded",
          ]) {
            expect(parsed.fulltext).not.toContain(excluded);
            expect(JSON.stringify(parsed.documentAst.blocks)).not.toContain(
              excluded,
            );
          }
          injected.$("script, style").remove();
          expect(
            validateAst(
              buildValidationHtml([injected.$(".DocContent").text()]),
              parsed.documentAst.blocks,
            ).ok,
          ).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  },
  propertyTestTimeout(30_000),
);

const runs = fc.array(
  fc.constantFrom(
    "<p>Text odstavce.</p>",
    "<p><b>První text</b> <i>druhý text</i> &amp; &#382;luťoučký.</p>",
    "<p>  &#160; </p>",
  ),
  { minLength: 1, maxLength: 8 },
);

test(
  "Czech constitutional RTF body markers retain their source order",
  () => {
    assertProperty(
      "Czech constitutional RTF body markers retain their source order",
      fc.property(markerPlan, runs, (plan, paragraphs) => {
        const injected = injectMarkupMarkers({
          source: `<html><body>${paragraphs.join("")}</body></html>`,
          selector: "body",
          excludedSelector: "script, style",
          plan,
        });
        const texts = injected
          .$("p")
          .toArray()
          .map((node) => injected.$(node).text());
        const fixture = cheerio.load(
          '<html><body><span id="lblDecisionForm">NÁLEZ</span><input id="docContentHidden"><div class="DocContent">visibleqzexcluded</div></body></html>',
        );
        fixture("#docContentHidden").attr(
          "value",
          `{\\rtf1{\\header headerqzexcluded}{\\footer footerqzexcluded}Ústavní soud rozhodl.\\par ${texts.join("\\par ")}\\par}`,
        );
        const parsed = parseUsDecisionHtml({
          ...metadata,
          html: fixture.html(),
        });
        expectMarkerRetention(parsed.fulltext, injected.markers);
        for (const excluded of [
          "visibleqzexcluded",
          "headerqzexcluded",
          "footerqzexcluded",
        ]) {
          expect(parsed.fulltext).not.toContain(excluded);
        }
        expect(
          validateAst(
            buildValidationHtml(["Ústavní soud rozhodl.", ...texts]),
            parsed.documentAst.blocks,
          ).ok,
        ).toBe(true);
      }),
      { numRuns: 20 },
    );
  },
  propertyTestTimeout(30_000),
);
