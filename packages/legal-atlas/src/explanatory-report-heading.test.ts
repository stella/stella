import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { assertProperty } from "@stll/property-testing";

import {
  formatExplanatoryReferences,
  MAX_EXPLANATORY_TARGETS,
  parseExplanatoryHeading,
} from "./explanatory-report-heading";

const reference = fc.record({
  unit: fc.constant("section" as const),
  section: fc.integer({ min: 1, max: 9999 }),
  sectionSuffix: fc.constantFrom(null, "a", "b"),
  subsection: fc.option(fc.integer({ min: 1, max: 99 }).map(String), {
    nil: null,
  }),
  letter: fc.constantFrom(null, "a", "b", "z"),
  point: fc.option(fc.integer({ min: 1, max: 99 }).map(String), { nil: null }),
  sentence: fc.constant(null),
  openEnded: fc.constant(false),
});

describe("explanatory headings", () => {
  test("explanatory heading ranges expand to their Cartesian target count", () => {
    assertProperty(
      "explanatory heading ranges expand to their Cartesian target count",
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        fc.constantFrom(" ", "\u00a0", "\u202f"),
        (start, sections, paragraphs, space) => {
          const parsed = parseExplanatoryHeading(
            `K § ${start} až ${start + sections - 1} odst. 1 až ${paragraphs}`
              .replaceAll(" ", () => space)
              .normalize("NFD"),
            "CZE",
          );
          expect(parsed.status).toBe("parsed");
          if (
            parsed.status !== "parsed" ||
            parsed.target.type !== "provisions"
          ) {
            return;
          }
          expect(parsed.target.references).toHaveLength(sections * paragraphs);
          for (let section = start; section < start + sections; section++) {
            for (let subsection = 1; subsection <= paragraphs; subsection++) {
              expect(
                parsed.target.references.some(
                  (ref) =>
                    ref.section === section &&
                    ref.subsection === String(subsection),
                ),
              ).toBe(true);
            }
          }
        },
      ),
    );
  });

  test("explanatory full paths round-trip without changing scope", () => {
    assertProperty(
      "explanatory full paths round-trip without changing scope",
      fc.property(
        fc.uniqueArray(reference, {
          minLength: 1,
          maxLength: 8,
          selector: JSON.stringify,
        }),
        (references) => {
          const heading = formatExplanatoryReferences(references, "CZE");
          expect(heading).not.toBeNull();
          if (heading === null) {
            return;
          }
          const parsed = parseExplanatoryHeading(heading, "CZE");
          expect(parsed.status).toBe("parsed");
          if (
            parsed.status !== "parsed" ||
            parsed.target.type !== "provisions"
          ) {
            return;
          }
          expect(parsed.target.references).toEqual(references);
        },
      ),
    );
  });

  test.each([
    "K § 5 odst. 1 písm. a), § 6 odst. 2",
    "K §5 odst. 1 písm. a) a b)",
    "K § 5 odst. 1 písm. a) bodu 2 až 3",
    "K §§ 5-7",
  ])("reads full and inherited target paths %s", (heading) => {
    const parsed = parseExplanatoryHeading(heading, "CZE");
    expect(parsed.status).toBe("parsed");
    if (parsed.status !== "parsed" || parsed.target.type !== "provisions") {
      return;
    }
    expect(parsed.target.references.length).toBeGreaterThan(1);
  });

  test("explanatory bill point ranges preserve article scope", () => {
    assertProperty(
      "explanatory bill point ranges preserve article scope",
      fc.property(
        fc.integer({ min: 1, max: 80 }),
        fc.integer({ min: 1, max: 30 }),
        (start, count) => {
          const parsed = parseExplanatoryHeading(
            `K čl. IV bodům ${start} až ${start + count - 1}`,
            "CZE",
          );
          expect(parsed.status).toBe("parsed");
          if (
            parsed.status !== "parsed" ||
            parsed.target.type !== "amendment_points"
          ) {
            return;
          }
          expect(parsed.target.article).toBe("4");
          expect(parsed.target.points).toEqual(
            Array.from({ length: count }, (_, index) => start + index),
          );
        },
      ),
    );
  });

  test.each([
    { heading: "K části první", kind: "part", values: ["1"] },
    { heading: "K hlavě II", kind: "chapter", values: ["2"] },
    { heading: "K příloze č. 2", kind: "annex", values: ["2"] },
    { heading: "K úvodní větě", kind: "opening_sentence", values: [] },
    {
      heading: "K čl. III a V (Technický předpis)",
      kind: "article",
      values: ["3", "5"],
    },
  ] as const)(
    "preserves structural scope $heading",
    ({ heading, kind, values }) => {
      const parsed = parseExplanatoryHeading(heading, "CZE");
      expect(parsed.status).toBe("parsed");
      if (parsed.status !== "parsed" || parsed.target.type !== "structure") {
        return;
      }
      expect(parsed.target.kind).toBe(kind);
      expect(parsed.target.designators).toEqual(values);
    },
  );

  test.each([
    "",
    "§ 5",
    "K § 5 extra",
    "K § 5 § 6",
    "K § 0",
    "K § 5 až 1",
    "K § 1a až 5b",
    "K hlavě IIX",
    "K bodu 0",
    "K § 1 až 99999999999999999999",
    `K § 1 až ${MAX_EXPLANATORY_TARGETS + 1}`,
    "K \ud800",
    "K § 1\0",
  ])("rejects an incomplete or unbounded heading %j", (heading) => {
    expect(parseExplanatoryHeading(heading, "CZE").status).toBe("unsupported");
  });

  test("explanatory designators reject Unicode case-fold lookalikes", () => {
    assertProperty(
      "explanatory designators reject Unicode case-fold lookalikes",
      fc.property(
        fc.constantFrom("ſ", "K", "ı"),
        fc.constantFrom("§ 5", "§ 5 odst. 1", "§ 5 písm. "),
        (letter, prefix) => {
          expect(
            parseExplanatoryHeading(`K ${prefix}${letter}`, "CZE").status,
          ).toBe("unsupported");
        },
      ),
    );
    expect(parseExplanatoryHeading("K čl. ı", "CZE").status).toBe(
      "unsupported",
    );
  });

  test("every unconfigured jurisdiction returns typed unsupported", () => {
    for (const jurisdiction of CASE_LAW_JURISDICTIONS) {
      if (jurisdiction === "CZE") {
        continue;
      }
      expect(parseExplanatoryHeading("K § 5", jurisdiction)).toEqual({
        status: "unsupported",
        reason: "jurisdiction",
      });
    }
  });
});
