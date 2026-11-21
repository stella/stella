import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  assertProperty,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  isUsCodeWork,
  locateUsCodeCitations,
  normalizeUsCodeReference,
  parseUsCodeAnchor,
  parseUsCodeWorkIdentifier,
  usCodeAnchor,
  usCodeReference,
  usCodeWorkIdentifier,
} from "./us-code-citations";

const USC_SPELLINGS = [
  "U.S.C.",
  "U. S. C.",
  "USC",
  "U.S.C.A.",
  "U.S.C.S.",
  "U.S. Code",
  "United States Code",
] as const;
const CFR_SPELLINGS = ["C.F.R.", "CFR", "C. F. R."] as const;
const MARKERS = [" § ", " §", " sec. ", " Section ", " ", "\u00a0§\u00a0"];
const LABELS = ["a", "b", "1", "2", "10", "A", "B", "i", "ii", "iv", "I", "aa"];

const path = fc.array(fc.constantFrom(...LABELS), { maxLength: 4 });

/**
 * A Code section number: a base, the letters of an inserted section, and the
 * short hyphenated tail of a section inserted after it (`2000e-2`).
 */
const uscSection = fc
  .record({
    number: fc.integer({ min: 1, max: 99_999 }),
    letters: fc.constantFrom("", "a", "b", "e", "j", "aa", "gg", "bbb"),
    tail: fc.option(fc.integer({ min: 1, max: 99 }), { nil: undefined }),
  })
  .map(({ number, letters, tail }) =>
    tail === undefined || String(tail).length >= String(number).length
      ? `${String(number)}${letters}`
      : `${String(number)}${letters}-${String(tail)}`,
  );

/** A CFR section number: part, point, section, and a FAR or Treasury tail. */
const cfrSection = fc
  .record({
    part: fc.integer({ min: 1, max: 9999 }),
    section: fc.integer({ min: 1, max: 9999 }),
    tail: fc.option(fc.integer({ min: 1, max: 99 }), { nil: undefined }),
  })
  .map(
    ({ part, section, tail }) =>
      `${String(part)}.${String(section)}${tail === undefined ? "" : `-${String(tail)}`}`,
  );

const generated = fc.oneof(
  fc
    .record({
      title: fc.integer({ min: 1, max: 54 }),
      spelling: fc.constantFrom(...USC_SPELLINGS),
      marker: fc.constantFrom(...MARKERS),
      section: uscSection,
      path,
    })
    .map((parts) => ({ ...parts, code: "U.S.C." })),
  fc
    .record({
      title: fc.integer({ min: 1, max: 50 }),
      spelling: fc.constantFrom(...CFR_SPELLINGS),
      marker: fc.constantFrom(...MARKERS),
      section: cfrSection,
      path,
    })
    .map((parts) => ({ ...parts, code: "C.F.R." })),
);

const PROSE = [
  "The court held ",
  "Plaintiffs sued under ",
  "See also ",
  "(citing ",
  "",
] as const;
const AFTER = [
  ". The court",
  "; see also id.",
  ", and the court",
  " (2018).",
  "",
];

/** Text an adversary can build from the pieces of a citation. */
const hostileText = fc.oneof(
  fc.string({ maxLength: 400 }),
  fc
    .array(
      fc.constantFrom(
        "42",
        "1",
        " ",
        "\n",
        "\u00a0",
        "U.S.C.",
        "U. S. C.",
        "C.F.R.",
        "CFR",
        "Title ",
        "§",
        "§§",
        "sec.",
        "1983",
        "1026.18",
        "2000e",
        "-",
        "\u2013",
        "(a)",
        "(1)",
        "(k)",
        ",",
        " and ",
        " et seq.",
        "Treas. Reg.",
        "FAR",
        "*5",
        "app.",
        "pt.",
      ),
      { maxLength: 80 },
    )
    .map((parts) => parts.join("")),
  fc
    .tuple(
      fc.constantFrom("42 U.S.C. §§ 1, ", "(a)", "§ ", "1-", "12 CFR 1.1-"),
      fc.integer({ min: 1, max: 4000 }),
    )
    .map(([token, count]) => `42 U.S.C. § 1${token.repeat(count)}`),
);

describe("US code citation properties", () => {
  test(
    "a generated citation is read back whole, with its identity and path",
    () => {
      assertProperty(
        "a generated citation is read back whole, with its identity and path",
        fc.property(
          generated,
          fc.constantFrom(...PROSE),
          fc.constantFrom(...AFTER),
          (citation, before, after) => {
            const printed = `${String(citation.title)} ${citation.spelling}${citation.marker}${citation.section}${citation.path.map((label) => `(${label})`).join("")}`;
            const text = `${before}${printed}${after}`;
            const found = locateUsCodeCitations(text);
            expect(found).toHaveLength(1);
            const [only] = found;
            expect(
              only === undefined ? null : text.slice(only.start, only.end),
            ).toBe(printed);
            expect(
              only === undefined ? null : usCodeWorkIdentifier(only.work),
            ).toBe(
              `${String(citation.title)} ${citation.code} ${citation.section}`,
            );
            expect(only?.path).toEqual(citation.path);
          },
        ),
        { numRuns: 400, seed: propertySeed() },
      );
    },
    propertyTestTimeout(20_000),
  );

  test(
    "every listed section of a citation is read, in order",
    () => {
      assertProperty(
        "every listed section of a citation is read, in order",
        fc.property(
          fc.integer({ min: 1, max: 54 }),
          fc.uniqueArray(uscSection, { minLength: 2, maxLength: 6 }),
          fc.constantFrom(", ", ", and ", " and ", "; "),
          (title, sections, connector) => {
            const text = `${String(title)} U.S.C. §§ ${sections.join(connector)}.`;
            expect(
              locateUsCodeCitations(text).map(({ work }) => work.section),
            ).toEqual(sections);
          },
        ),
        { numRuns: 200, seed: propertySeed() },
      );
    },
    propertyTestTimeout(20_000),
  );

  test(
    "any text yields only ordered, in-bounds citations of real sections",
    () => {
      assertProperty(
        "any text yields only ordered, in-bounds citations of real sections",
        fc.property(hostileText, (text) => {
          const found = locateUsCodeCitations(text);
          let previousStart = 0;
          for (const citation of found) {
            expect(citation.start).toBeGreaterThanOrEqual(previousStart);
            expect(citation.end).toBeGreaterThan(citation.start);
            expect(citation.end).toBeLessThanOrEqual(text.length);
            expect(isUsCodeWork(citation.work)).toBe(true);
            const identifier = usCodeWorkIdentifier(citation.work);
            expect(parseUsCodeWorkIdentifier(identifier)).toEqual(
              citation.work,
            );
            const reference = usCodeReference(citation);
            expect(reference).not.toBeNull();
            if (reference !== null) {
              expect(normalizeUsCodeReference(reference)).toEqual(reference);
              expect(parseUsCodeAnchor(usCodeAnchor(reference))).toEqual({
                ...reference,
                openEnded: false,
              });
            }
            previousStart = citation.start;
          }
          // Reading is a function of the text alone.
          expect(locateUsCodeCitations(text)).toEqual(found);
        }),
        { numRuns: 300, seed: propertySeed() },
      );
    },
    propertyTestTimeout(30_000),
  );

  test(
    "text before a citation moves it and changes nothing else",
    () => {
      assertProperty(
        "text before a citation moves it and changes nothing else",
        fc.property(
          generated,
          fc.string({ maxLength: 60 }),
          (citation, noise) => {
            const printed = `${String(citation.title)} ${citation.spelling}${citation.marker}${citation.section}`;
            const prefix = `${noise.replaceAll(/[\p{N}§.()]/gu, () => "x")} `;
            const alone = locateUsCodeCitations(printed);
            const moved = locateUsCodeCitations(`${prefix}${printed}`);
            expect(
              moved.map(({ work, path: labels }) => ({ work, labels })),
            ).toEqual(
              alone.map(({ work, path: labels }) => ({ work, labels })),
            );
            expect(moved.map(({ start }) => start - prefix.length)).toEqual(
              alone.map(({ start }) => start),
            );
          },
        ),
        { numRuns: 200, seed: propertySeed() },
      );
    },
    propertyTestTimeout(20_000),
  );
});
