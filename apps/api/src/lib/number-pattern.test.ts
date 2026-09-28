import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { renderMatterReference } from "@stll/api-contract";

import { validatePattern } from "@/api/lib/matter-reference";
import {
  MAX_NUMBER_SERIES_SEQUENCE_DIGITS,
  toNumberPatternScopeKey,
  validateNumberPattern,
} from "@/api/lib/number-pattern";

describe("document number pattern", () => {
  test("reserves the ten digits a counter can render without changing matter validation", () => {
    const pattern = `${"A".repeat(55)}{SEQ}`;
    expect(Result.isOk(validatePattern(pattern, 3))).toBe(true);
    expect(
      Result.isError(
        validateNumberPattern({
          pattern,
          padding: 3,
          sequenceDigitsBudget: MAX_NUMBER_SERIES_SEQUENCE_DIGITS,
        }),
      ),
    ).toBe(true);
  });

  test("derives the period and number in the explicit UTC billing zone", () => {
    const instant = new Date("2025-12-31T23:30:00.000Z");
    const pattern = "{YYYY}-{MM}-{SEQ}";
    expect(
      toNumberPatternScopeKey({ pattern, now: instant, timeZone: "UTC" }),
    ).toBe("2025-12-");
    expect(
      renderMatterReference({
        now: instant,
        pattern,
        padding: 3,
        seq: 1,
        timeZone: "UTC",
      }),
    ).toBe("2025-12-001");
  });
});
