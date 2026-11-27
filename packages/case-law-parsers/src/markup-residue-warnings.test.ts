import { expect, test } from "bun:test";
import fc from "fast-check";

import type { ExtractionWarnings } from "@stll/api-contract/case-law-extraction-warnings";
import { assertProperty } from "@stll/property-testing";

import { markupResidueIn, markupResidueWarnings } from "./markup-residue";

test("residue warnings retain every rule and bound offsets while counting every match", () => {
  const text = `<p>word</p> <b>word</b> &amp; &amp; &unknown; ${"a".repeat(40)}`;
  expect(markupResidueWarnings(text)).toEqual([
    { rule: "html-tag", count: 4, firstOffsets: [0, 7, 12] },
    { rule: "entity", count: 2, firstOffsets: [24, 30] },
    { rule: "hex-run", count: 1, firstOffsets: [46] },
  ]);
  markupResidueIn(text);
  expect(markupResidueWarnings(text)).toEqual(markupResidueWarnings(text));
});

test("residue warning counts and locations survive repeated scans", () => {
  assertProperty(
    "residue warning counts and locations survive repeated scans",
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: 0, max: 50 }),
      (count, prefixLength) => {
        const prefix = "z".repeat(prefixLength);
        const text = prefix + "<p>word ".repeat(count);
        const expected = [
          {
            rule: "html-tag",
            count,
            firstOffsets: Array.from(
              { length: Math.min(count, 3) },
              (_, index) => prefixLength + index * 8,
            ),
          },
        ] satisfies ExtractionWarnings;
        expect(markupResidueWarnings(text)).toEqual(expected);
        markupResidueIn(text);
        expect(markupResidueWarnings(text)).toEqual(expected);
      },
    ),
  );
});

test("ordinary text has typed empty warnings", () => {
  expect(markupResidueWarnings("The court decided the appeal.")).toEqual([]);
});
