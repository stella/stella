import { Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  extractCitations,
  extractDecisionCitations,
  normalizeDecisionIdentifier,
} from "./citation-extractor";

const noise = fc
  .array(
    fc.constantFrom("x", "č", "😀", " ", "\u00a0", "\u2003", "/", "§", "9"),
    { maxLength: 80 },
  )
  .map((parts) => parts.join(""));
const docket = fc
  .tuple(
    fc.integer({ min: 1, max: 99 }),
    fc.constantFrom("Cdo", "As", "Tdo"),
    fc.integer({ min: 1, max: 99_999 }),
    fc.integer({ min: 2000, max: 2026 }),
    fc.constantFrom(" ", "\u00a0", "\u2003", "\n"),
  )
  .map(
    ([chamber, registry, number, year, gap]) =>
      `${String(chamber)}${gap}${registry}${gap}${String(number)}/${String(year)}`,
  );
const identifier = fc.oneof(
  docket.map((value) => ({
    type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    value,
  })),
  fc
    .constantFrom(
      "I. ÚS 123/2020",
      "Pfv.III.20.123/2019/5",
      "II SA/Po 1234/99",
      "KIO 123/20",
      "C-123/20",
    )
    .map((value) => ({ type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value })),
  fc.integer({ min: 1, max: 9999 }).map((number) => ({
    type: DECISION_IDENTIFIER_TYPES.ECLI,
    value: `ECLI:CZ:NSS:2020:${String(number)}.1`,
  })),
  fc.integer({ min: 1, max: 999 }).map((number) => ({
    type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
    value: `[2020] UKSC ${String(number)}`,
  })),
  fc
    .constantFrom(
      "410 U.S. 113",
      "N 53/26 SbNU 73",
      "234/2002 Sb.",
      "BH 2019.123.",
    )
    .map((value) => ({
      type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      value,
    })),
);

const documentOf = (text: string): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "d", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "p",
      anchorId: "p",
      type: "paragraph",
      plainText: text,
      inlines: [{ type: "text", text }],
    },
  ],
});

test(
  "identifier normalization reaches a fixed point",
  () => {
    fc.assert(
      fc.property(identifier, (input) => {
        const value = normalizeDecisionIdentifier(input);
        expect(normalizeDecisionIdentifier({ type: input.type, value })).toBe(
          value,
        );
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "embedded dockets preserve verbatim text and section ownership",
  () => {
    fc.assert(
      fc.property(
        noise,
        docket.map((value) => `sp. zn. ${value}`),
        noise,
        fc.nat({ max: 1000 }),
        (before, citation, after, index) => {
          const text = `${before}; ${citation}; ${after}`;
          const sections = [{ index, text }];
          const citations = extractCitations(sections);
          expect(
            citations.some(({ citationText }) => citationText === citation),
          ).toBe(true);
          for (const found of citations) {
            expect(found.sectionIndex).toBe(index);
            expect(text).toContain(found.citationText);
          }
          const decision = extractDecisionCitations({
            country: "CZE",
            sections,
          });
          if (Result.isError(decision)) {
            throw decision.error;
          }
          expect(decision.value.citations).toEqual(citations);
          expect(decision.value.reading.type).toBe("patterns");
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "reporter occurrences shift with their source text",
  () => {
    fc.assert(
      fc.property(noise, noise, noise, (before, after, prefix) => {
        const citation = "410 U.S. 113";
        const text = `${before}; ${citation}; ${after}`;
        const lead = `${prefix}; `;
        const extract = (value: string) =>
          extractDecisionCitations({
            country: "USA",
            sections: [{ index: 0, text: value }],
            documentAst: documentOf(value),
          });
        const original = extract(text);
        const shifted = extract(lead + text);
        if (Result.isError(original)) {
          throw original.error;
        }
        if (Result.isError(shifted)) {
          throw shifted.error;
        }
        expect(original.value.occurrences.length).toBeGreaterThan(0);
        expect(
          original.value.citations.map(({ citationText }) => citationText),
        ).toContain(citation);
        for (const occurrence of original.value.occurrences) {
          expect(occurrence.start).toBeGreaterThanOrEqual(0);
          expect(occurrence.end).toBeGreaterThan(occurrence.start);
          expect(occurrence.end).toBeLessThanOrEqual(text.length);
          expect(text.slice(occurrence.start, occurrence.end)).toBe(citation);
        }
        expect(
          shifted.value.occurrences.map((occurrence) => ({
            ...occurrence,
            start: occurrence.start - lead.length,
            end: occurrence.end - lead.length,
          })),
        ).toEqual(original.value.occurrences);
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "long separator runs retain an embedded citation within a time bound",
  () => {
    fc.assert(
      fc.property(
        fc.constantFrom("/", "9", "§", "\u00a0", "\u2003", " , / "),
        fc.integer({ min: 1000, max: 12_000 }),
        (fragment, count) => {
          const citation = "sp. zn. 21 Cdo 1234/2020";
          const text = `${fragment.repeat(count)}; ${citation};`;
          const started = performance.now();
          const citations = extractCitations([{ index: 0, text }]);
          expect(performance.now() - started).toBeLessThan(2000);
          expect(
            citations.some(({ citationText }) => citationText === citation),
          ).toBe(true);
          for (const found of citations) {
            expect(text).toContain(found.citationText);
          }
        },
      ),
      propertyConfig({ numRuns: 20, seed: propertySeed() }),
    );
  },
  propertyTestTimeout(15_000),
);
