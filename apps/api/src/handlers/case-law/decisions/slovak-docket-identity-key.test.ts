import { expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import { propertyConfig } from "@stll/property-testing";

import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";

/**
 * Search answers a docket from `citation_key`, keyed by `bareCitationKey` of
 * the grammar's formatted docket, while ingestion keys the court's case
 * number with the same function. The grammar's canonical key, the key of what
 * it formats, and the key ingestion stores must be one string, or a docket
 * that parses still finds nothing.
 */
test("a Slovak Constitutional Court docket keys as ingestion stores it", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("I", "II", "III", "IV", "PL"),
      fc.integer({ min: 1, max: 99_999 }),
      fc.constantFrom("98", "04", "2017"),
      fc.constantFrom(". ", ".", " "),
      fc.constantFrom("ÚS", "US", "ús", "us"),
      fc.boolean(),
      (senate, ordinal, year, separator, mark, lower) => {
        const stored = bareCitationKey(`${senate}. ÚS ${ordinal}/${year}`);
        const typed = `${lower ? senate.toLowerCase() : senate}${separator}${mark} ${ordinal}/${year}`;
        const parsed = DECISION_DOCKET_GRAMMARS.SVK.parse(typed);
        expect(parsed?.canonical, typed).toBe(stored);
        expect(parsed && bareCitationKey(parsed.formatted), typed).toBe(stored);
      },
    ),
    propertyConfig(),
  );
});
