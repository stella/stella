import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  authenticLanguageTag,
  preferredLanguageVersionsFirst,
} from "@/api/lib/case-law/decision-language";

describe("the language version a lookup answers in", () => {
  test("reads the authority code a notice states as a row language", () => {
    expect(authenticLanguageTag("ENG")).toBe("en");
    expect(authenticLanguageTag("DEU")).toBe("de");
    expect(authenticLanguageTag("ces")).toBe("cs");
    expect(authenticLanguageTag(null)).toBeNull();
    expect(authenticLanguageTag("not a code")).toBeNull();
  });

  test("prefers the decision's own language, then English, then the first", () => {
    const versions = (authenticLanguage: string | null) =>
      ["bg", "cs", "de", "en"].map((language) => ({
        id: `${language}-version`,
        language,
        languageGroupKey: "ECLI:EU:C:2005:709",
        authenticLanguage,
      }));
    expect(preferredLanguageVersionsFirst(versions("de")).at(0)?.language).toBe(
      "de",
    );
    expect(preferredLanguageVersionsFirst(versions(null)).at(0)?.language).toBe(
      "en",
    );
    expect(
      preferredLanguageVersionsFirst(
        versions("fr").filter(({ language }) => language !== "en"),
      ).at(0)?.language,
    ).toBe("bg");
  });

  test("decision-language.preferred-version-permutes", async () => {
    // Reordering may only move a group's preferred version into the group's
    // first position: no row is lost or duplicated, every group keeps its
    // first position, and rows outside a group keep theirs.
    await assertProperty(
      "decision-language.preferred-version-permutes",
      fc.asyncProperty(
        fc.array(
          fc.record({
            language: fc.constantFrom("bg", "cs", "de", "en", "fr"),
            languageGroupKey: fc.option(fc.constantFrom("a", "b", "c")),
            authenticLanguage: fc.option(fc.constantFrom("de", "fr")),
          }),
          { maxLength: 12 },
        ),
        async (rows) => {
          const ordered = preferredLanguageVersionsFirst(rows);
          expect(ordered).toHaveLength(rows.length);
          expect(new Set(ordered)).toEqual(new Set(rows));
          const firstPositions = (list: typeof rows) =>
            list.map(
              (row, index) =>
                row.languageGroupKey === null ||
                list.findIndex(
                  (other) => other.languageGroupKey === row.languageGroupKey,
                ) === index,
            );
          expect(firstPositions(ordered)).toEqual(firstPositions(rows));
          for (const [index, row] of rows.entries()) {
            if (row.languageGroupKey === null) {
              expect(ordered[index]).toBe(row);
            }
          }
        },
      ),
    );
  });
});
