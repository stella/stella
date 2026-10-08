import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty, propertyConfig } from "@stll/property-testing";

import {
  decisionParagraphFragment,
  decisionParagraphRangeSchema,
  formatDecisionParagraphRange,
  parseDecisionParagraphFragment,
  parseDecisionParagraphRange,
} from "./decision-paragraph-range";

describe("decision paragraph ranges", () => {
  test("schema reads a string and transforms both dash spellings into an inclusive range", () => {
    expect(v.safeParse(decisionParagraphRangeSchema, "48")).toMatchObject({
      success: true,
      output: { from: 48, to: 48 },
    });
    expect(v.safeParse(decisionParagraphRangeSchema, "48-53")).toMatchObject({
      success: true,
      output: { from: 48, to: 53 },
    });
    expect(v.safeParse(decisionParagraphRangeSchema, "48–53")).toMatchObject({
      success: true,
      output: { from: 48, to: 53 },
    });
  });

  test("reports malformed, reversed, and over-wide input with distinct typed reasons", () => {
    const garbage = parseDecisionParagraphRange("0");
    const reversed = parseDecisionParagraphRange("4-3");
    const tooWide = parseDecisionParagraphRange("1-501");
    expect(garbage.isError()).toBe(true);
    expect(garbage.isError() && garbage.error.reason).toBe("garbage");
    expect(reversed.isError() && reversed.error.reason).toBe("reversed");
    expect(tooWide.isError() && tooWide.error.reason).toBe("too-wide");
  });

  test("accepts the full 500-number inclusive span and rejects unsafe integers", () => {
    expect(parseDecisionParagraphRange("1-500").isOk()).toBe(true);
    expect(parseDecisionParagraphRange("9007199254740992").isError()).toBe(
      true,
    );
    expect(v.safeParse(decisionParagraphRangeSchema, "1-501").success).toBe(
      false,
    );
    for (const input of [
      "",
      " 48",
      "48 ",
      "-48",
      "48.5",
      "1e2",
      "48--53",
      "48—53",
      "0",
      "48-0",
      "9".repeat(1000),
    ]) {
      const parsed = parseDecisionParagraphRange(input);
      expect(parsed.isError()).toBe(true);
      expect(parsed.isError() && parsed.error.reason).toBe("garbage");
      expect(v.safeParse(decisionParagraphRangeSchema, input).success).toBe(
        false,
      );
    }
    const maximum = String(Number.MAX_SAFE_INTEGER);
    expect(parseDecisionParagraphRange(maximum).isOk()).toBe(true);
    expect(v.safeParse(decisionParagraphRangeSchema, maximum).success).toBe(
      true,
    );
  });

  test("formatting and fragments round-trip the canonical hyphen spelling", () => {
    const range = { from: 48, to: 53 };
    expect(formatDecisionParagraphRange({ from: 48, to: 48 })).toBe("48");
    expect(formatDecisionParagraphRange(range)).toBe("48-53");
    expect(decisionParagraphFragment(range)).toBe("par=48-53");
    expect(parseDecisionParagraphFragment("#par=48–53")).toEqual(range);
    expect(parseDecisionParagraphFragment("par=48-53")).toEqual(range);
    expect(parseDecisionParagraphFragment("#par=48-53&other=value")).toBeNull();
    expect(parseDecisionParagraphFragment("#other=48-53")).toBeNull();
  });

  test("formatting is a fixed point for every valid range", () => {
    assertProperty(
      "formatting is a fixed point for every valid range",
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 499 }),
        (from, offset) => {
          const range = { from, to: from + offset };
          const parsed = parseDecisionParagraphRange(
            formatDecisionParagraphRange(range),
          );
          expect(parsed.isOk()).toBe(true);
          expect(parsed.isOk() && parsed.value).toEqual(range);
        },
      ),
      propertyConfig(),
    );
  });
});
