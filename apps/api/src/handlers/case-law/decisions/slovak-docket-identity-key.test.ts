import { expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import { propertyConfig } from "@stll/property-testing";

import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";

/** A Constitutional Court docket as a reader types it or a publisher prints it. */
const constitutionalSpelling = fc.record({
  dot: fc.constantFrom("", "."),
  gap: fc.constantFrom("", " "),
  join: fc.constantFrom("", " ", "  ", "/", " / "),
  lower: fc.boolean(),
  mark: fc.constantFrom("ÚS", "US", "ús", "us", "ÚS"),
  ordinal: fc.integer({ min: 1, max: 99_999 }),
  senate: fc.constantFrom("I", "II", "III", "IV", "PL", "Pl"),
  year: fc.constantFrom("98", "04", "2017"),
});

/**
 * Search answers a docket from `citation_key`, keyed by `bareCitationKey` of
 * the grammar's formatted docket, while ingestion keys the court's case
 * number with the same function. The two must agree in both directions over
 * one space of spellings: whatever the grammar accepts keys as ingestion
 * stores the court's spelling, and whatever ingestion folds onto that key the
 * grammar accepts, or a docket either parses and finds nothing or is stored
 * under a spelling a reader cannot look up.
 *
 * One narrowing is deliberate: the grammar keeps the senate apart from `ÚS`
 * (`plus 5/98` is prose), while ingestion, reading case numbers rather than
 * reader input, also folds a glued `IIÚS 5/98`.
 */
test("a Slovak Constitutional Court docket keys as ingestion stores it", () => {
  fc.assert(
    fc.property(
      constitutionalSpelling,
      ({ dot, gap, join, lower, mark, ordinal, senate, year }) => {
        const stored = bareCitationKey(`${senate}. ÚS ${ordinal}/${year}`);
        const typed = `${lower ? senate.toLowerCase() : senate}${dot}${gap}${mark}${join}${ordinal}/${year}`;
        const parsed = DECISION_DOCKET_GRAMMARS.SVK.parse(typed);
        if (parsed !== null) {
          expect(parsed.canonical, typed).toBe(stored);
          expect(bareCitationKey(parsed.formatted), typed).toBe(stored);
        }
        const gluedToMark = dot === "" && gap === "";
        if (bareCitationKey(typed) === stored && !gluedToMark) {
          expect(parsed?.canonical, typed).toBe(stored);
        }
      },
    ),
    propertyConfig(),
  );
});

/**
 * The converse: a publisher stores the case number in any spelling the grammar
 * reads (the court's case lists print it compact, `II.ÚS55/98`), and the
 * identity lookup keys the grammar's formatted docket. Ingestion's key of the
 * stored spelling must be the lookup's key, or the row is unreachable by its
 * own docket.
 */
test("a Slovak Constitutional Court docket stored in any accepted spelling is found by its formatted query", () => {
  fc.assert(
    fc.property(
      constitutionalSpelling,
      ({ dot, gap, join, lower, mark, ordinal, senate, year }) => {
        const stored = `${lower ? senate.toLowerCase() : senate}${dot}${gap}${mark}${join}${ordinal}/${year}`;
        const parsed = DECISION_DOCKET_GRAMMARS.SVK.parse(stored);
        if (parsed === null) {
          return;
        }
        expect(bareCitationKey(stored), stored).toBe(
          bareCitationKey(parsed.formatted),
        );
      },
    ),
    propertyConfig(),
  );
});
