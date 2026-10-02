import { describe, expect, test } from "bun:test";

import {
  FORCED_VALUE_CASES,
  FORCED_VALUE_KEEP_CLASSES,
  FORCED_VALUE_REDACT_CLASSES,
  NAME_MATCHING_CASES,
  NAME_MATCHING_KEEP_CLASSES,
  NAME_MATCHING_REDACT_CLASSES,
} from "@/api/mcp/__fixtures__/name-matching-corpus";
import type {
  NameMatchingCase,
  NameMatchingKeepClass,
  NameMatchingRedactClass,
} from "@/api/mcp/__fixtures__/name-matching-corpus";
import {
  measureNameMatchingCorpus,
  NAME_MATCHING_MATCHERS,
  nameMatchingCaseHeld,
} from "@/api/tests/helpers/name-matching-corpus";

/**
 * Minimum number of redact cases per class that must stay redacted on the
 * anonymized request path. `held` counts every redacted case; `attributed`
 * counts the cases only the matcher under test redacts, where the same fields
 * without it stay visible. Raise a floor when a change redacts more; never
 * lower one to make a change pass.
 */
const RECALL_FLOORS = {
  exact: { held: 11, attributed: 3 },
  case: { held: 7, attributed: 7 },
  "diacritics-dropped": { held: 8, attributed: 0 },
  "diacritics-added": { held: 5, attributed: 3 },
  "typo-1": { held: 7, attributed: 1 },
  "typo-2": { held: 6, attributed: 2 },
  inflected: { held: 13, attributed: 7 },
  "inflected-diacritics-dropped": { held: 7, attributed: 4 },
  "legal-form-variant": { held: 11, attributed: 2 },
  split: { held: 9, attributed: 4 },
  "common-word-person": { held: 5, attributed: 3 },
  "forced-exact": { held: 2, attributed: 2 },
  "forced-case": { held: 1, attributed: 1 },
  "forced-embedded": { held: 2, attributed: 2 },
} as const satisfies Record<
  NameMatchingRedactClass,
  { held: number; attributed: number }
>;

/**
 * Maximum number of keep cases per class the matcher under test may redact
 * (redacted with it, intact without it), for every matcher that runs the
 * class. Lower a ceiling when a change redacts less; never raise one to make
 * a change pass.
 */
const FALSE_POSITIVE_CEILINGS = {
  hex: 0,
  uuid: 0,
  hash: 0,
  "id-code": 0,
  marker: 0,
  "ordinary-word": 0,
  "adjacent-word": 0,
  "forced-near-miss": 0,
  "forced-other-id": 0,
  "forced-adjacent-word": 0,
} as const satisfies Record<NameMatchingKeepClass, number>;

const countOccurrences = (text: string, surface: string) => {
  let count = 0;
  let offset = text.indexOf(surface);
  while (offset !== -1) {
    count += 1;
    offset = text.indexOf(surface, offset + 1);
  }
  return count;
};

describe("name-matching corpus", () => {
  test("every labeled surface occurs exactly once in its text", () => {
    for (const testCase of [...NAME_MATCHING_CASES, ...FORCED_VALUE_CASES]) {
      expect({
        surface: testCase.surface,
        occurrences: countOccurrences(testCase.text, testCase.surface),
      }).toEqual({ surface: testCase.surface, occurrences: 1 });
    }
  });

  test("declared classes and exercised classes match in both directions", () => {
    const exercised = (cases: readonly NameMatchingCase[]) =>
      new Set(cases.map((testCase) => testCase.kind));

    expect(exercised(NAME_MATCHING_CASES)).toEqual(
      new Set([...NAME_MATCHING_REDACT_CLASSES, ...NAME_MATCHING_KEEP_CLASSES]),
    );
    expect(exercised(FORCED_VALUE_CASES)).toEqual(
      new Set([...FORCED_VALUE_REDACT_CLASSES, ...FORCED_VALUE_KEEP_CLASSES]),
    );
  });

  test("a redact case holds only once every identifying word is gone", () => {
    const testCase: NameMatchingCase = {
      expectation: "redact",
      kind: "legal-form-variant",
      surface: "Lipová Invest, spol. s r. o.",
      text: "Investor: Lipová Invest, spol. s r. o.",
    };

    expect(
      nameMatchingCaseHeld(
        testCase,
        "Investor: [ORGANIZATION_1], spol. s r. o.",
      ),
    ).toBe(true);
    expect(
      nameMatchingCaseHeld(
        testCase,
        "Investor: [ORGANIZATION_1] Invest, spol. s r. o.",
      ),
    ).toBe(false);
    expect(nameMatchingCaseHeld(testCase, testCase.text)).toBe(false);
  });

  test("a keep case holds only while its surface is intact", () => {
    const testCase: NameMatchingCase = {
      expectation: "keep",
      kind: "uuid",
      surface: "9b1d0c3e-acfe-4ca1-8b2e-5c7a0a1b2c3d",
      text: "request 9b1d0c3e-acfe-4ca1-8b2e-5c7a0a1b2c3d failed",
    };

    expect(nameMatchingCaseHeld(testCase, testCase.text)).toBe(true);
    expect(
      nameMatchingCaseHeld(
        testCase,
        "request [ORGANIZATION_1]-4ca1-8b2e-5c7a0a1b2c3d failed",
      ),
    ).toBe(false);
  });

  test("recall and false positives on the anonymized request path stay within each class bound", async () => {
    const report = await measureNameMatchingCorpus();
    const tallies = NAME_MATCHING_MATCHERS.flatMap((matcher) =>
      Object.entries(report[matcher]).map(([kind, tally]) => ({
        matcher,
        kind,
        tally,
      })),
    );

    const floors: ReadonlyMap<string, { held: number; attributed: number }> =
      new Map(Object.entries(RECALL_FLOORS));
    const ceilings: ReadonlyMap<string, number> = new Map(
      Object.entries(FALSE_POSITIVE_CEILINGS),
    );
    const outOfBounds = tallies.flatMap(({ matcher, kind, tally }) => {
      if (tally.expectation === "redact") {
        const floor = floors.get(kind);
        return floor === undefined ||
          tally.held < floor.held ||
          tally.attributed < floor.attributed
          ? [{ matcher, kind, bound: JSON.stringify(floor), tally }]
          : [];
      }
      const ceiling = ceilings.get(kind);
      return ceiling === undefined || tally.attributedFalsePositives > ceiling
        ? [{ matcher, kind, bound: JSON.stringify(ceiling), tally }]
        : [];
    });
    const measuredKinds = new Set(tallies.map(({ kind }) => kind));
    const unmeasured = [...floors.keys(), ...ceilings.keys()].filter(
      (kind) => !measuredKinds.has(kind),
    );
    const splitFailures = tallies.filter(
      ({ tally }) => tally.splitFailures > 0,
    );

    expect(outOfBounds).toEqual([]);
    expect(unmeasured).toEqual([]);
    expect(splitFailures).toEqual([]);
  }, 60_000);
});
