import { expect, test } from "bun:test";
import fc from "fast-check";

import { load } from "@stll/html";
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

test(
  "Czech supreme body markers retain their source order",
  () => {
    assertProperty(
      "Czech supreme body markers retain their source order",
      fc.property(
        markerPlan,
        shapes,
        wrappers,
        (plan, fragments, ancestors) => {
          let body = `<p>Nejvyšší soud rozhodl takto: Návrh se zamítá.</p><p>Odůvodnění: Posouzení návrhu.</p>${fragments.join("")}`;
          for (const tag of ancestors) {
            body = `<${tag}>${body}</${tag}>`;
          }
          const fixture = load(
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

/**
 * An older print page sets each caption line in its own run, which the
 * parser merges into one paragraph and then cuts at the case number. Every
 * caption character must survive the cut, in order; only a letter-spaced
 * word's spacing may change, as the letter-spacing reader states.
 */
const captionPreamble = fc.option(
  fc.constantFrom("NEJVYŠŠÍ SOUD ČESKÉ REPUBLIKY", "NEJVYŠŠÍ SOUD"),
  { nil: undefined },
);
const captionCaseNumber = fc.constantFrom(
  "21 Cdo 4994/2007",
  "29 Odo 975/2006",
  "6 Tdo 647/2017",
);
const captionTitleLines = fc.array(
  fc.constantFrom(
    "ČESKÁ REPUBLIKA",
    "ROZSUDEK",
    "U S N E S E N Í",
    "JMÉNEM REPUBLIKY",
  ),
  { minLength: 1, maxLength: 4 },
);

const parseCaption = (lines: readonly string[]) => {
  const runs = lines
    .map((line) => `<font face="Arial CE">${line} </font><br>\n<br>\n`)
    .join("");
  return parseNsDecisionHtml({
    documentId: "property-fixture",
    webUrl: "https://example.test/detail",
    printUrl: "https://example.test/print",
    webHtml: "",
    printHtml: `<html><body><table id="box-table-a"><tr><td>Soud:</td><td>NS</td></tr></table><br><p><br>${runs}<font face="Arial CE">Nejvyšší soud České republiky rozhodl v senátě takto:</font><br></p></body></html>`,
  });
};

const withoutWhitespace = (text: string): string => text.replaceAll(/\s/gu, "");

const LETTER_SPACED = /^\p{L}(?: \p{L})+$/u;

test(
  "a run-on caption keeps every character in order",
  () => {
    assertProperty(
      "a run-on caption keeps every character in order",
      fc.property(
        captionPreamble,
        captionCaseNumber,
        captionTitleLines,
        (preamble, caseNumber, titleLines) => {
          const lines = [
            ...(preamble === undefined ? [] : [preamble]),
            caseNumber,
            ...titleLines,
          ];
          const parsed = parseCaption(lines);
          const text = parsed.documentAst.blocks
            .map((block) => block.plainText)
            .join(" ");
          expect(withoutWhitespace(text)).toContain(
            withoutWhitespace(lines.join("")),
          );
          // A line that is not letter-spaced keeps its own spacing.
          for (const line of lines.filter((l) => !LETTER_SPACED.test(l))) {
            expect(text.replaceAll(/\s+/gu, " ")).toContain(line);
          }
        },
      ),
    );
  },
  propertyTestTimeout(30_000),
);

/**
 * A printed caption: the state above the decision type, the formula below
 * it, each on a line of its own. Whichever lines the court printed, the
 * decision type is the decision's title.
 */
const printedCaption = fc.record({
  state: fc.boolean(),
  decisionType: fc.constantFrom("ROZSUDEK", "USNESENÍ", "U S N E S E N Í"),
  formula: fc.boolean(),
});

test(
  "a printed caption's decision type is its title",
  () => {
    assertProperty(
      "a printed caption's decision type is its title",
      fc.property(
        captionPreamble,
        captionCaseNumber,
        printedCaption,
        (preamble, caseNumber, { state, decisionType, formula }) => {
          const parsed = parseCaption([
            ...(preamble === undefined ? [] : [preamble]),
            caseNumber,
            ...(state ? ["ČESKÁ REPUBLIKA"] : []),
            decisionType,
            ...(formula ? ["JMÉNEM REPUBLIKY"] : []),
          ]);
          const titles = parsed.documentAst.blocks.filter(
            (block) =>
              block.type === "heading" && block.role === "decision-title",
          );
          expect(
            titles.map(({ plainText }) => withoutWhitespace(plainText)),
          ).toEqual([withoutWhitespace(decisionType)]);
        },
      ),
    );
  },
  propertyTestTimeout(30_000),
);
