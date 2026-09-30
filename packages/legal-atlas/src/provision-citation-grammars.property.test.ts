import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  locateGazetteCitations,
  type LocatedGazetteCitation,
  PROVISION_CITATION_GRAMMARS,
} from "./provision-citation-grammars";

const czech = PROVISION_CITATION_GRAMMARS.CZE;
const whitespace = fc.constantFrom(" ", "  ", "\t", "\n", "\u00a0", "\u202f");
const safePrefix = fc
  .array(fc.constantFrom("x", "č", "🙂", "e\u0301", "\u202e", " ", "\n"), {
    maxLength: 80,
  })
  .map((parts) => `${parts.join("")}; `);
const sectionArbitrary = fc.integer({ min: 1, max: 9999 });
const suffixArbitrary = fc.constantFrom("", "a", "b", "z");
const letterArbitrary = fc.constantFrom("a", "b", "c", "z");
const abbreviationArbitrary = fc.constantFrom(
  "s. ř. s.",
  "s.ř.s.",
  "s ř s",
  "S. Ř. S.",
);
const provision = fc
  .record({
    section: sectionArbitrary,
    suffix: suffixArbitrary,
    subsection: fc.integer({ min: 1, max: 999 }),
    letter: letterArbitrary,
    point: fc.integer({ min: 1, max: 999 }),
    gap: whitespace,
    abbreviation: abbreviationArbitrary,
  })
  .map(({ section, suffix, subsection, letter, point, gap, abbreviation }) => ({
    printed: `§${gap}${section}${suffix}${gap}odst.${gap}${subsection}${gap}písm.${gap}${letter})${gap}bod${gap}${point}`,
    abbreviation,
    anchor: `par_${section}${suffix}-odst_${subsection}-pism_${letter}-bod_${point}`,
    reference: {
      letter,
      openEnded: false,
      point: String(point),
      section,
      sectionSuffix: suffix === "" ? null : suffix,
      sentence: null,
      subsection: String(subsection),
      unit: "section" as const,
    },
  }));

const hostileText = fc.oneof(
  fc.string({ maxLength: 400 }),
  fc
    .tuple(
      fc.constantFrom("§", ",", "9", "/", "\u00a0", " "),
      fc.integer({ min: 12_000, max: 16_000 }),
    )
    .map(([token, count]) => `§ ${token.repeat(count)} odst. s. ř. s.`),
  fc
    .array(
      fc.tuple(
        fc.constantFrom(
          "§",
          ",",
          " a ",
          " ve spojení s ",
          "9",
          "/",
          "\u00a0",
          " ",
        ),
        fc.integer({ min: 1, max: 128 }),
      ),
      { minLength: 1, maxLength: 24 },
    )
    .map((runs) => runs.map(([token, count]) => token.repeat(count)).join("")),
  fc
    .tuple(
      sectionArbitrary,
      whitespace,
      fc.integer({ min: 1, max: 256 }),
      fc.boolean(),
    )
    .map(
      ([number, gap, count, closed]) =>
        `${`§${gap}${number},${gap}`.repeat(count)}${closed ? "1 s. ř. s." : "odst."}`,
    ),
);

type Span = { start: number; end: number };

const expectSpans = (text: string, citations: readonly Span[]) => {
  let previousEnd = 0;
  for (const { start, end } of citations) {
    expect(Number.isInteger(start)).toBe(true);
    expect(Number.isInteger(end)).toBe(true);
    expect(start).toBeGreaterThanOrEqual(previousEnd);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThanOrEqual(text.length);
    previousEnd = end;
  }
};

describe("provision citation grammar properties", () => {
  test(
    "embedded provisions retain their printed spans and normalized references",
    () => {
      fc.assert(
        fc.property(
          provision,
          safePrefix,
          hostileText,
          (citation, prefix, suffix) => {
            const text = `${prefix}${citation.printed} ${citation.abbreviation}; ${suffix}`;
            const first = czech.locateAbbreviatedProvisions(text).at(0);
            expect(first).toEqual({
              abbreviation: {
                canonicalAbbreviation: "s. ř. s.",
                eli: "https://www.e-sbirka.cz/eli/cz/sb/2002/150",
              },
              anchor: citation.anchor,
              start: prefix.length,
              end: prefix.length + citation.printed.length,
              jurisdiction: "CZE",
              reference: citation.reference,
            });
            expect(text.slice(first?.start, first?.end)).toBe(citation.printed);
            const uppercase = czech
              .locateAbbreviatedProvisions(text.toUpperCase())
              .at(0);
            expect(uppercase?.anchor).toBe(citation.anchor);
            expect(uppercase?.reference).toEqual(citation.reference);
          },
        ),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "coordinated provisions keep each span and inherit their section",
    () => {
      fc.assert(
        fc.property(
          sectionArbitrary,
          suffixArbitrary,
          whitespace,
          safePrefix,
          fc.array(sectionArbitrary, { minLength: 2, maxLength: 12 }),
          (number, suffix, gap, prefix, subsections) => {
            const spans = subsections.map((value, index) =>
              index === 0
                ? `§${gap}${number}${suffix}${gap}odst.${gap}${value}`
                : String(value),
            );
            const text = `${prefix}${spans.join(`${gap}a${gap}`)}${gap}s. ř. s.`;
            const citations = czech.locateAbbreviatedProvisions(text);
            expectSpans(text, citations);
            expect(
              citations.map(({ start, end }) => text.slice(start, end)),
            ).toEqual(spans);
            expect(citations.map(({ anchor }) => anchor)).toEqual(
              subsections.map(
                (value) => `par_${number}${suffix}-odst_${value}`,
              ),
            );
          },
        ),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "gazette spans locate the printed work inside surrounding text",
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 99_999 }),
          fc.integer({ min: 1000, max: 9999 }),
          whitespace,
          safePrefix,
          hostileText,
          (number, year, gap, prefix, suffix) => {
            const printed = `č.${gap}${number}/${year}${gap}Sb.`;
            const text = `${prefix}${printed}; ${suffix}`;
            const expected = {
              eli: `https://www.e-sbirka.cz/eli/cz/sb/${year}/${number}`,
              start: prefix.length,
              end: prefix.length + printed.length,
              jurisdiction: "CZE",
            } as const satisfies LocatedGazetteCitation;
            expect(czech.locateGazetteCitations(text).at(0)).toEqual(expected);
            expect(locateGazetteCitations(text).at(0)).toEqual(expected);
            expect(text.slice(expected.start, expected.end)).toBe(printed);
          },
        ),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "adversarial text preserves bounded spans and prefix offset shifts within a runtime bound",
    () => {
      fc.assert(
        fc.property(hostileText, safePrefix, (text, prefix) => {
          const started = performance.now();
          const provisions = czech.locateAbbreviatedProvisions(text);
          const gazettes = locateGazetteCitations(text);
          expectSpans(text, provisions);
          expectSpans(text, gazettes);
          expect(czech.locateAbbreviatedProvisions(prefix + text)).toEqual(
            provisions.map((citation) =>
              ({ ...citation, start: citation.start + prefix.length,
                end: citation.end + prefix.length,}),
            ),
          );
          expect(locateGazetteCitations(prefix + text)).toEqual(
            gazettes.map((citation) =>
              ({ ...citation, start: citation.start + prefix.length,
                end: citation.end + prefix.length,}),
            ),
          );
          expect(performance.now() - started).toBeLessThan(2000);
        }),
        propertyConfig({ numRuns: 40, seed: propertySeed() }),
      );
    },
    propertyTestTimeout(20_000),
  );
});
