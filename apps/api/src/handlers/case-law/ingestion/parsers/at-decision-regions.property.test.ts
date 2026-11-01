/**
 * An Austrian decision is read in one pass that only moves forward: head
 * matter, ruling, reasons, closing, annex. Whatever the court prints and
 * wherever the publisher files it, no paragraph takes the role of a part the
 * reader has already left. The one exception is the place-and-date line,
 * which closes only itself.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { ParagraphRole } from "@stll/legal-ast/document-ast";
import {
  assertProperty,
  propertyConfig,
  propertySeed,
} from "@stll/property-testing";

import {
  type AtCourtTextSection,
  readAtDecisionRegions,
} from "@/api/handlers/case-law/ingestion/parsers/at-decision-regions";

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

const DOCKET = "W224 2231206-1";

const PLACE_DATE = "Wien, am 2. Jänner 2026";

/** Every marker the reader acts on, and prose that is none. */
const PRINTED_LINES = [
  "BESCHEID",
  "IM NAMEN DER REPUBLIK!",
  "GEKÜRZTE AUSFERTIGUNG DES MÜNDLICH VERKÜNDETEN ERKENNTNISSES",
  "Betrifft:",
  `${DOCKET}/13E`,
  "Das Bundesverwaltungsgericht hat durch die Richterin Dr. X zu Recht erkannt:",
  "Der Umweltsenat hat durch Dr. X als Vorsitzenden und Dr.",
  "über die Berufung zu Recht erkannt:",
  "Spruch:",
  "SPRUCH",
  "Begründung:",
  "Entscheidungsgründe",
  "Rechtliche Beurteilung",
  "Rechtsmittelbelehrung:",
  "Anhänge zu den Auflagen:",
  "Beilage:",
  PLACE_DATE,
  "Der Beschwerde wird Folge gegeben.",
  "Der Beschwerdeführer hat durch seinen Vertreter vorgebracht:",
  "Gemäß § 28 Abs. 2 VwGVG ist der Bescheid zu beheben.",
] as const;

const SECTIONS = [
  "operative",
  "reasons",
  "text",
] as const satisfies readonly AtCourtTextSection[];

/** Head matter, ruling, reasons, closing, annex: the order the reader keeps. */
const rankOf = (role: ParagraphRole | undefined): number => {
  switch (role) {
    case "intro":
    case "case-number": {
      return 0;
    }
    case "holding": {
      return 1;
    }
    case "argumentation": {
      return 2;
    }
    case "closing": {
      return 3;
    }
    case undefined: {
      return 4;
    }
    default: {
      throw new Error(`unexpected role ${role}`);
    }
  }
};

const lineArb = fc.record({
  text: fc.constantFrom(...PRINTED_LINES),
  section: fc.constantFrom(...SECTIONS),
});

describe("Austrian decision regions", () => {
  test("a paragraph never returns to a part the reader has left", () => {
    assertProperty(
      "a paragraph never returns to a part the reader has left",
      fc.property(
        fc.array(lineArb, { maxLength: 40 }),
        fc.array(fc.constantFrom(...PRINTED_LINES), { maxLength: 5 }),
        (lines, headingTexts) => {
          const regions = readAtDecisionRegions([DOCKET]);
          let reached = 0;
          for (const [index, { text, section }] of lines.entries()) {
            const heading = headingTexts[index];
            if (heading !== undefined) {
              regions.heading(heading);
            }
            const role = regions.paragraph(text, section);
            if (text === PLACE_DATE && role === "closing") {
              continue;
            }
            const rank = rankOf(role);
            expect(rank).toBeGreaterThanOrEqual(reached);
            reached = rank;
          }
        },
      ),
      config(500),
    );
  });
});
