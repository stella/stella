import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { dropOverlappingSpans } from "./text-spans.js";

const legalText = fc
  .array(fc.constantFrom("§", "č", "ř", "ľ", "ô", "Z\u030c", "a\u0301", " "), {
    minLength: 1,
    maxLength: 30,
  })
  .map((parts) => parts.join(""));

describe("legal text spans", () => {
  test("keeps the earlier, longer span at touching and overlapping edges", () => {
    expect(
      dropOverlappingSpans([
        { start: 2, end: 4, label: "later" },
        { start: 0, end: 3, label: "short" },
        { start: 0, end: 4, label: "long" },
        { start: 4, end: 5, label: "touching" },
      ]),
    ).toEqual([
      { start: 0, end: 4, label: "long" },
      { start: 4, end: 5, label: "touching" },
    ]);
  });

  test("returns ordered, non-overlapping offsets inside UTF-16 text", () => {
    assertProperty(
      "returns ordered, non-overlapping offsets inside UTF-16 text",
      fc.property(
        legalText,
        fc.array(fc.nat(), { maxLength: 40 }),
        (text, seeds) => {
          const spans = seeds.map((seed, index) => {
            const start = seed % text.length;
            const width = seeds.at(index + 1) ?? seed;
            const end = start + 1 + (width % (text.length - start));
            return { start, end, index };
          });
          const kept = dropOverlappingSpans(spans);

          for (const [index, span] of kept.entries()) {
            expect(span.start).toBeGreaterThanOrEqual(0);
            expect(span.end).toBeLessThanOrEqual(text.length);
            expect(span.start).toBeLessThan(span.end);
            expect(text.slice(span.start, span.end).length).toBe(
              span.end - span.start,
            );
            const previous = index === 0 ? undefined : kept.at(index - 1);
            if (previous !== undefined) {
              expect(span.start).toBeGreaterThanOrEqual(previous.end);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
