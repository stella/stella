import { panic } from "better-result";
import { expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  buildValidationHtml,
  validateAst,
} from "@/api/lib/legal-search/parsers/validate-ast";

import { parseRegionalDecision } from "./cz-regional";
import type { ParseRegionalInput } from "./cz-regional";
import {
  expectMarkerRetention,
  injectMarkupMarkers,
  markerPlan,
} from "./marker-injection.test-helper";

const paragraph = fc.record({
  styleLocalId: fc.integer({ min: 1, max: 4 }),
  spans: fc.array(
    fc.record({
      text: fc.constantFrom(
        "Text odstavce.",
        "žluťoučký kůň",
        "První\n\ndruhý",
        "  \u00a0 ",
        "1. Posouzení návrhu.",
        "Poučení: Návrh se zamítá.",
        "§ 1 písm. a)",
      ),
      anonStyle: fc.constantFrom("NORMAL", "ANON"),
    }),
    { minLength: 1, maxLength: 5 },
  ),
  cell: fc.constantFrom("paragraph", "table-cell"),
});
const sections = fc.record({
  header: fc.array(paragraph, { minLength: 1, maxLength: 3 }),
  verdict: fc.array(paragraph, { minLength: 1, maxLength: 3 }),
  justification: fc.array(paragraph, { minLength: 1, maxLength: 3 }),
  information: fc.array(paragraph, { minLength: 1, maxLength: 3 }),
});
const id = "Czech regional section markers retain their source order";

test(
  id,
  () => {
    assertProperty(
      id,
      fc.property(
        markerPlan,
        sections,
        fc.constantFrom("structured", "fallback"),
        (plan, source, mode) => {
          const ordered = [
            ...source.header,
            ...source.verdict,
            ...source.justification,
            ...source.information,
          ];
          // Markup is only a transport for the shared marker injector; the parser receives plain JSON text fields.
          const fixture = cheerio.load("<html><body></body></html>");
          for (const para of ordered) {
            const element = fixture("<p></p>");
            for (const span of para.spans)
              {element.append(fixture("<span></span>").text(span.text));}
            fixture("body").append(element);
          }
          const marked = injectMarkupMarkers({
            source: fixture.html(),
            selector: "body",
            excludedSelector: "script, style",
            plan,
          });
          const elements = marked.$("p").toArray();
          let ordinal = 0;
          const readSection = (paragraphs: typeof source.header) =>
            paragraphs.map((para) => {
              const element =
                elements.at(ordinal++) ??
                panic("Every JSON paragraph has a marker transport element");
              const texts = marked
                .$(element)
                .children("span")
                .toArray()
                .map((span, index) => ({
                  text: marked.$(span).text(),
                  anonStyle: (
                    para.spans.at(index) ??
                    panic("Every transport span has a JSON text field")
                  ).anonStyle,
                }));
              return {
                texts,
                styleLocalId: para.styleLocalId,
                tableCellInfo:
                  para.cell === "table-cell" ? { row: 0, column: 0 } : null,
              };
            });
          const header = readSection(source.header);
          const verdict = readSection(source.verdict);
          const justification = readSection(source.justification);
          const information = readSection(source.information);
          const textOf = (paragraphs: typeof header) =>
            paragraphs
              .map((para) => para.texts.map(({ text }) => text).join(""))
              .join("\n\n");
          const input = {
            caseNumber: "property-fixture",
            ecli: undefined,
            court: "fixture court",
            decisionDate: undefined,
            decisionType: "rozsudek",
            sourceUrl: undefined,
            header,
            verdict: mode === "structured" ? verdict : [],
            justification: mode === "structured" ? justification : [],
            information,
            styles: [1, 2, 3, 4].map((localId) => ({
              localId,
              alignment: "left",
              hasSpaceBefore: false,
              hasSpaceAfter: false,
              bold: localId === 2 || localId === 4,
              italic: localId === 3 || localId === 4,
            })),
            verdictText:
              mode === "structured"
                ? "verdictfallbackqzexcluded"
                : textOf(verdict),
            justificationText:
              mode === "structured"
                ? "reasoningfallbackqzexcluded"
                : textOf(justification),
          } satisfies ParseRegionalInput;
          const parsed = parseRegionalDecision(input);
          expectMarkerRetention(parsed.fulltext, marked.markers);
          expect(parsed.fulltext).not.toContain("verdictfallbackqzexcluded");
          expect(parsed.fulltext).not.toContain("reasoningfallbackqzexcluded");
          expect(
            validateAst(
              buildValidationHtml([
                textOf(header),
                textOf(verdict),
                textOf(justification),
                textOf(information),
              ]),
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
