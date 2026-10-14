import { describe, expect, test } from "bun:test";

import {
  getMatterColor,
  getMatterPickerColor,
  getMatterSwatch,
  MATTER_SWATCHES,
  resolveMatterColor,
  toStoredMatterColor,
} from "./matter-colors";

describe("getMatterSwatch", () => {
  test("always returns the same swatch for the same id (deterministic hash)", () => {
    const id = "matter-abc-123";
    expect(getMatterSwatch(id)).toBe(getMatterSwatch(id));
  });

  test("returned swatch is within MATTER_SWATCHES", () => {
    for (const id of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
      expect(MATTER_SWATCHES).toContain(getMatterSwatch(id));
    }
  });

  test("different ids spread across multiple swatches", () => {
    const seen = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(getMatterSwatch),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("getMatterColor", () => {
  test("wraps the swatch in a CSS var() expression", () => {
    const id = "some-matter";
    expect(getMatterColor(id)).toBe(`var(${getMatterSwatch(id)})`);
  });
});

describe("getMatterPickerColor", () => {
  test("returns the swatch name (without --option- prefix) when color is null", () => {
    const swatch = getMatterSwatch("picker-id");
    const expected = swatch.slice("--option-".length);
    expect(getMatterPickerColor("picker-id", null)).toBe(expected);
  });

  test("strips # from a hex color", () => {
    expect(getMatterPickerColor("any-id", "#A1B2C3")).toBe("A1B2C3");
  });

  test("strips --option- prefix from a CSS-var token", () => {
    expect(getMatterPickerColor("any-id", "--option-violet")).toBe("violet");
  });
});

describe("toStoredMatterColor", () => {
  test("normalises a hex color to uppercase with # prefix", () => {
    expect(toStoredMatterColor("a1b2c3")).toBe("#A1B2C3");
    expect(toStoredMatterColor("#a1b2c3")).toBe("#A1B2C3");
  });

  test("returns --option-* tokens unchanged", () => {
    expect(toStoredMatterColor("--option-emerald")).toBe("--option-emerald");
  });

  test("prepends --option- to bare color names", () => {
    expect(toStoredMatterColor("cyan")).toBe("--option-cyan");
  });
});

describe("resolveMatterColor — round-trip with toStoredMatterColor", () => {
  test("hex input round-trips through storage and resolution", () => {
    const stored = toStoredMatterColor("FF5733");
    expect(resolveMatterColor("id", stored)).toBe("#FF5733");
  });

  test("CSS-var token resolves to var() form", () => {
    expect(resolveMatterColor("id", "--option-teal")).toBe(
      "var(--option-teal)",
    );
  });

  test("bare color name resolves to var(--option-*)", () => {
    expect(resolveMatterColor("id", "orange")).toBe("var(--option-orange)");
  });

  test("falls back to id-hash color when color is null", () => {
    const id = "fallback-id";
    expect(resolveMatterColor(id, null)).toBe(getMatterColor(id));
  });
});
