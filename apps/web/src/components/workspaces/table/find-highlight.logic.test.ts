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
      { matched: true, text: "Lease" },
      { matched: false, text: " and " },
      { matched: true, text: "lease" },
    ]);
  });

  test("marks nothing for an empty term", () => {
    expect(splitByMatch("Lease", "")).toEqual([
      { matched: false, text: "Lease" },
    ]);
  });

  test("marks adjacent occurrences separately", () => {
    expect(splitByMatch("aaaa", "aa")).toEqual([
      { matched: true, text: "aa" },
      { matched: true, text: "aa" },
    ]);
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
