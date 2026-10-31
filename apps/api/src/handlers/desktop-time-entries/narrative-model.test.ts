import { expect, test } from "bun:test";
import fc from "fast-check";

import { DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH } from "@stll/api-contract/desktop-time-entries";
import { assertProperty } from "@stll/property-testing";

import { capNarrative } from "./narrative-model";

const LONE_HIGH_SURROGATE_AT_END = /[\uD800-\uDBFF]$/u;

const narrativeArb = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 40 }),
  fc
    .tuple(
      fc.integer({
        min: DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH - 3,
        max: DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH + 3,
      }),
      fc.string({ unit: "grapheme", minLength: 1, maxLength: 8 }),
    )
    .map(([length, tail]) => `${"n".repeat(length - 1)}${tail}`),
);

test("a capped narrative is a prefix within the entry limit that keeps every surrogate pair whole", () => {
  assertProperty(
    "a capped narrative is a prefix within the entry limit that keeps every surrogate pair whole",
    fc.property(narrativeArb, (narrative) => {
      const capped = capNarrative(narrative);
      expect(capped.length).toBeLessThanOrEqual(
        DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH,
      );
      expect(narrative.startsWith(capped)).toBe(true);
      expect(LONE_HIGH_SURROGATE_AT_END.test(capped)).toBe(false);
      if (narrative.length <= DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH) {
        expect(capped).toBe(narrative);
      }
    }),
  );
});

test("the cut steps back over an emoji that straddles the entry limit", () => {
  const narrative = `${"n".repeat(DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH - 1)}😀`;
  // The pair straddles the limit, so a plain slice would end on its high half.
  expect(
    LONE_HIGH_SURROGATE_AT_END.test(
      narrative.slice(0, DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH),
    ),
  ).toBe(true);
  expect(capNarrative(narrative)).toBe(
    "n".repeat(DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH - 1),
  );
});
