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
 */
const RECALL_FLOORS = {
  exact: 11,
  case: 7,
  "diacritics-dropped": 8,
  "diacritics-added": 2,
  "typo-1": 7,
  "typo-2": 6,
  inflected: 11,
  "inflected-diacritics-dropped": 6,
  "legal-form-variant": 9,
  split: 8,
  "forced-exact": 2,
  "forced-case": 1,
  "forced-embedded": 2,
} as const satisfies Record<NameMatchingRedactClass, number>;

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

  test("recall on the anonymized request path stays at or above each class floor", async () => {
    const report = await measureNameMatchingCorpus({
      modes: ["deny-list", "forced"],
    });
    const measured: Partial<Record<string, number>> = {
      ...Object.fromEntries(
        Object.entries(report["deny-list"] ?? {}).map(([kind, tally]) => [
          kind,
          tally.passed,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(report.forced ?? {})
          .filter(([kind]) => kind.startsWith("forced-"))
          .map(([kind, tally]) => [kind, tally.passed]),
      ),
    };

    const belowFloor = Object.entries(RECALL_FLOORS)
      .map(([kind, floor]) => ({ kind, floor, held: measured[kind] ?? 0 }))
      .filter(({ floor, held }) => held < floor);

    expect(belowFloor).toEqual([]);
  }, 60_000);
});
