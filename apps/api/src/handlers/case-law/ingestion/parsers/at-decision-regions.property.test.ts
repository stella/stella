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
  type AtPrintedLine,
  readAtDecisionRoles,
} from "@/api/handlers/case-law/ingestion/parsers/at-decision-regions";

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

const DOCKET = "W224 2231206-1";

const PLACE_DATE = "Wien, am 2. Jänner 2026";

const LETTERHEAD = "St. Pölten, am 4. September 2023";

/** A place and date closes only its own line. */
const PLACE_DATES: ReadonlySet<string> = new Set([PLACE_DATE, LETTERHEAD]);

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
  "Das Rekursgericht hat erwogen:",
  "Das Landesverwaltungsgericht Wien erkennt durch seinen Richter Dr. X",
  "Die Auflage A.1 wird wie folgt abgeändert:",
  "Beilage: Erlagschein",
  LETTERHEAD,
  "Gemäß § 28 Abs. 2 VwGVG ist der Bescheid zu beheben.",
] as const;

const SECTIONS = [
  "operative",
  "reasons",
  "text",
] as const satisfies readonly AtCourtTextSection[];

/**
 * Head matter, ruling, reasons, closing, annex: the order the reader keeps.
 * The reader gives no other role; meeting one fails the property.
 */
const RANK: ReadonlyMap<ParagraphRole | undefined, number> = new Map<
  ParagraphRole | undefined,
  number
>([
  ["intro", 0],
  ["case-number", 0],
  ["holding", 1],
  ["argumentation", 2],
  ["closing", 3],
  [undefined, 4],
]);

const rankOf = (role: ParagraphRole | undefined): number => {
  const rank = RANK.get(role);
  if (rank === undefined) {
    throw new Error(`unexpected role ${String(role)}`);
  }
  return rank;
};

const lineArb: fc.Arbitrary<AtPrintedLine> = fc.oneof(
  fc.record({
    type: fc.constant("paragraph" as const),
    text: fc.constantFrom(...PRINTED_LINES),
    section: fc.constantFrom(...SECTIONS),
  }),
  fc.record({
    type: fc.constant("heading" as const),
    text: fc.constantFrom(...PRINTED_LINES),
  }),
  fc.constant({ type: "break" as const }),
  fc.constant({ type: "field" as const }),
);

describe("Austrian decision regions", () => {
  test("a paragraph never returns to a part the reader has left", () => {
    assertProperty(
      "a paragraph never returns to a part the reader has left",
      fc.property(fc.array(lineArb, { maxLength: 40 }), (lines) => {
        const roles = readAtDecisionRoles(lines, [DOCKET]);
        expect(roles).toHaveLength(lines.length);
        let reached = 0;
        for (const [index, line] of lines.entries()) {
          const role = roles[index];
          if (line.type !== "paragraph") {
            // Headings, fields and breaks take no role from the reader.
            expect(role).toBeUndefined();
            continue;
          }
          if (PLACE_DATES.has(line.text) && role === "closing") {
            continue;
          }
          const rank = rankOf(role);
          expect(rank).toBeGreaterThanOrEqual(reached);
          reached = rank;
        }
      }),
      config(500),
    );
  });
});
