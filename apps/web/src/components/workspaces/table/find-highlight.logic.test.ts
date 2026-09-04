import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { splitByMatch } from "@/components/workspaces/table/find-highlight.logic";

const joined = (text: string, term: string): string =>
  splitByMatch(text, term)
    .map((segment) => segment.text)
    .join("");

describe("splitting rendered text on a find term", () => {
  test("marks every occurrence, whatever its case", () => {
    expect(splitByMatch("Lease and lease", "LEASE")).toEqual([
      { matched: true, start: 0, text: "Lease" },
      { matched: false, start: 5, text: " and " },
      { matched: true, start: 10, text: "lease" },
    ]);
  });

  test("marks nothing for an empty term", () => {
    expect(splitByMatch("Lease", "")).toEqual([
      { matched: false, start: 0, text: "Lease" },
    ]);
  });

  test("marks adjacent occurrences separately", () => {
    expect(splitByMatch("aaaa", "aa")).toEqual([
      { matched: true, start: 0, text: "aa" },
      { matched: true, start: 2, text: "aa" },
    ]);
  });

  test("a segment starts where the input says it does", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (text, term) => {
        for (const segment of splitByMatch(text, term)) {
          expect(
            text.slice(segment.start, segment.start + segment.text.length),
          ).toBe(segment.text);
        }
      }),
      propertyConfig(),
    );
  });

  test("segments always reassemble into the input", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (text, term) => {
        expect(joined(text, term)).toBe(text);
      }),
      propertyConfig(),
    );
  });

  test("every marked segment equals the term, case-insensitively", () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (text, term) => {
        for (const segment of splitByMatch(text, term)) {
          if (segment.matched) {
            expect(segment.text.toLocaleLowerCase()).toBe(
              term.toLocaleLowerCase(),
            );
          }
        }
      }),
      propertyConfig(),
    );
  });

  test("an empty term never marks anything", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(splitByMatch(text, "").some((segment) => segment.matched)).toBe(
          false,
        );
      }),
      propertyConfig(),
    );
  });
});
