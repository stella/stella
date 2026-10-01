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
  nameMatchingCaseHeld,
} from "@/api/mcp/name-matching-corpus.measure";

/**
 * Minimum number of redact cases per class that must stay redacted on the
 * anonymized request path. Raise a floor when a change redacts more; never
 * lower one to make a change pass.
 *
 * `typo-1` misses a one-letter typo of a five-letter name, which the matcher
 * now treats as too short for approximate matching; the next matcher release
 * raises this floor to the full class.
 */
const RECALL_FLOORS = {
  exact: 11,
  case: 7,
  "diacritics-dropped": 8,
  "diacritics-added": 5,
  "typo-1": 6,
  "typo-2": 6,
  inflected: 13,
  "inflected-diacritics-dropped": 7,
  "legal-form-variant": 11,
  split: 9,
  "forced-exact": 2,
  "forced-case": 1,
  "forced-embedded": 2,
} as const satisfies Record<NameMatchingRedactClass, number>;

/**
 * Maximum number of keep cases per class that may be redacted, in every mode
 * that runs the class. Lower a ceiling when a change redacts less; never raise
 * one to make a change pass.
 *
 * `marker` allows the one short name glued to a digit inside a marker-like
 * wrapper; the next matcher release lowers it to zero.
 */
const FALSE_POSITIVE_CEILINGS = {
  hex: 0,
  uuid: 0,
  hash: 0,
  "id-code": 0,
  marker: 1,
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
    const report = await measureNameMatchingCorpus({
      modes: ["deny-list", "forced"],
    });
    const denyList = report["deny-list"] ?? {};
    const forced = report.forced ?? {};

    const belowFloor = Object.entries(RECALL_FLOORS)
      .map(([kind, floor]) => ({
        kind,
        floor,
        held:
          (kind.startsWith("forced-") ? forced : denyList)[kind]?.passed ?? 0,
      }))
      .filter(({ floor, held }) => held < floor);

    const ceilings: ReadonlyMap<string, number> = new Map(
      Object.entries(FALSE_POSITIVE_CEILINGS),
    );
    const modes = [
      ["deny-list", denyList],
      ["forced", forced],
    ] as const;
    const aboveCeiling = modes.flatMap(([mode, tallies]) =>
      Object.entries(tallies).flatMap(([kind, tally]) => {
        if (tally.expectation !== "keep") {
          return [];
        }
        const ceiling = ceilings.get(kind);
        const redacted = tally.total - tally.passed;
        return ceiling === undefined || redacted > ceiling
          ? [{ mode, kind, ceiling, redacted, failures: tally.failures }]
          : [];
      }),
    );

    const unmeasured = [...ceilings.keys()].filter(
      (kind) => !modes.some(([, tallies]) => kind in tallies),
    );

    expect(belowFloor).toEqual([]);
    expect(aboveCeiling).toEqual([]);
    expect(unmeasured).toEqual([]);
  }, 60_000);
});
