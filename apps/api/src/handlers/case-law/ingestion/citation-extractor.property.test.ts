import { Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import {
  assertProperty,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  COMMISSION_CASE_CUES,
  CUE_GATED_CITATION_PATTERNS,
  extractCitations,
  extractDecisionCitations,
  normalizeDecisionIdentifier,
} from "./citation-extractor";

const commissionCaseNumber = fc.oneof(
  fc.integer({ min: 10_000, max: 99_999 }).map((number) => `AT.${number}`),
  fc
    .tuple(fc.integer({ min: 10, max: 99 }), fc.integer({ min: 100, max: 999 }))
    .map(([series, number]) => `COMP/${series}.${number}`),
  fc.integer({ min: 1000, max: 99_999 }).map((number) => `M.${number}`),
  fc.integer({ min: 1000, max: 99_999 }).map((number) => `SA.${number}`),
  fc
    .tuple(
      fc.constantFrom("C", "N", "NN"),
      fc.integer({ min: 1, max: 999 }),
      fc.integer({ min: 2050, max: 2099 }),
    )
    .map(([series, number, year]) => `${series} ${number}/${year}`),
);

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
  "Commission case numbers require a nearby official-language cue",
  () => {
    assertProperty(
      "Commission case numbers require a nearby official-language cue",
      fc.property(commissionCaseNumber, (caseNumber) => {
        expect(extractCitations([{ index: 0, text: caseNumber }])).toEqual([]);
        for (const { cue } of COMMISSION_CASE_CUES) {
          expect(
            extractCitations([{ index: 0, text: `${cue}: ${caseNumber}` }]),
          ).toEqual([
            expect.objectContaining({
              identifierType: DECISION_IDENTIFIER_TYPES.COMMISSION_CASE_NUMBER,
              identifierValue: caseNumber,
            }),
          ]);
        }
      }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "national docket prefixes cannot license Commission case numbers",
  () => {
    assertProperty(
      "national docket prefixes cannot license Commission case numbers",
      fc.property(
        fc.constantFrom("C", "N", "NN"),
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 1900, max: 2099 }),
        fc.oneof(
          fc.integer({ min: 1, max: 999 }).map(String),
          fc.constantFrom("I", "II", "III", "IV", "V", "VI", "VII"),
        ),
        (series, number, year, division) => {
          const text = `case no. ${division} ${series} ${String(number)}/${String(year)}`;
          expect(
            extractCitations([{ index: 0, text }]).filter(
              ({ identifierType }) =>
                identifierType ===
                DECISION_IDENTIFIER_TYPES.COMMISSION_CASE_NUMBER,
            ),
          ).toEqual([]);
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "identifier normalization reaches a fixed point",
  () => {
    assertProperty(
      "identifier normalization reaches a fixed point",
      fc.property(identifier, (input) => {
        const value = normalizeDecisionIdentifier(input);
        expect(normalizeDecisionIdentifier({ type: input.type, value })).toBe(
          value,
        );
      }),
      { seed: propertySeed() },
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "embedded dockets preserve verbatim text and section ownership",
  () => {
    assertProperty(
      "embedded dockets preserve verbatim text and section ownership",
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
      { seed: propertySeed() },
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "reporter occurrences shift with their source text",
  () => {
    assertProperty(
      "reporter occurrences shift with their source text",
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
        const adjustedOccurrences = [];
        for (const occurrence of shifted.value.occurrences) {
          adjustedOccurrences.push({
            ...occurrence,
            start: occurrence.start - lead.length,
            end: occurrence.end - lead.length,
          });
        }
        expect(adjustedOccurrences).toEqual(original.value.occurrences);
      }),
      { seed: propertySeed() },
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "long separator runs retain an embedded citation",
  () => {
    assertProperty(
      "long separator runs retain an embedded citation",
      fc.property(
        fc.constantFrom(" ", "I ", "/", "9", "§", "\u00a0", "\u2003", " , / "),
        fc.integer({ min: 1000, max: 48_000 }),
        // A Latin-1-only string takes the engine's one-byte path, where a
        // pattern rescanning a whitespace run can stay fast; a decision in
        // Czech or Polish is always two-byte text.
        fc.constantFrom("", "ł "),
        (fragment, count, lead) => {
          const citation = "sp. zn. 21 Cdo 1234/2020";
          const text = `${lead}${fragment.repeat(count)}; ${citation};`;
          const citations = extractCitations([{ index: 0, text }]);
          expect(
            citations.some(({ citationText }) => citationText === citation),
          ).toBe(true);
          for (const found of citations) {
            expect(text).toContain(found.citationText);
          }
        },
      ),
      { numRuns: 20, seed: propertySeed() },
    );
  },
  propertyTestTimeout(15_000),
);

const cueGateExamples = {
  "pl-tk": { number: "K 2/19", cue: "TK" },
  "pl-uodo": { number: "DKN.5131.6.2024", cue: "UODO" },
  "pl-uokik": { number: "DOK-1/2020", cue: "UOKiK" },
  "cz-uohs": { number: "ÚOHS-S123/2024/VZ", cue: "ÚOHS" },
  "cz-uoou": { number: "UOOU-12345/17-12", cue: "ÚOOÚ" },
  "eu-commission": { number: "AT.40099", cue: "case" },
} as const satisfies Record<
  (typeof CUE_GATED_CITATION_PATTERNS)[number]["id"],
  { number: string; cue: string }
>;

test("every cue-gated pattern rejects uncued numbers and accepts cues on enabled sides", () => {
  for (const gate of CUE_GATED_CITATION_PATTERNS) {
    const example = cueGateExamples[gate.id];
    expect(extractCitations([{ index: 0, text: example.number }])).toHaveLength(
      0,
    );
    if (gate.windowBefore > 0) {
      expect(
        extractCitations([
          { index: 0, text: `${example.cue} ${example.number}` },
        ]).some(({ citationText }) => citationText === example.number),
      ).toBe(true);
    }
    if (gate.windowAfter > 0) {
      expect(
        extractCitations([
          { index: 0, text: `${example.number} ${example.cue}` },
        ]).some(({ citationText }) => citationText === example.number),
      ).toBe(true);
    }
  }
});
