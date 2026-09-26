import { describe, expect, test } from "bun:test";

import {
  type DeterministicFieldConfig,
  formatDate,
  renderDeterministicFieldValue,
} from "./field-values.js";

describe("formatDate", () => {
  test("renders a locale-styled date (cs long → inflected month)", () => {
    expect(formatDate("2028-06-13", { locale: "cs", style: "long" })).toBe(
      "13. června 2028",
    );
  });

  test("de, pl, and en long styles localize per document language", () => {
    expect(formatDate("2028-06-13", { locale: "de", style: "long" })).toBe(
      "13. Juni 2028",
    );
    expect(formatDate("2028-06-13", { locale: "pl", style: "long" })).toBe(
      "13 czerwca 2028",
    );
    expect(formatDate("2028-06-13", { locale: "en", style: "long" })).toBe(
      "June 13, 2028",
    );
  });

  test("medium and short styles use the locale's compact conventions", () => {
    expect(formatDate("2028-06-13", { locale: "cs", style: "medium" })).toBe(
      "13. 6. 2028",
    );
    expect(formatDate("2028-06-13", { locale: "de", style: "short" })).toBe(
      "13.06.28",
    );
  });

  test("returns null for malformed input", () => {
    expect(
      formatDate("not-a-date", { locale: "en", style: "long" }),
    ).toBeNull();
    expect(
      formatDate("13.06.2028", { locale: "cs", style: "long" }),
    ).toBeNull();
  });

  test("accepts a leap day and rejects a nonexistent calendar day", () => {
    expect(formatDate("2028-02-29", { locale: "en", style: "iso" })).toBe(
      "2028-02-29",
    );
    expect(formatDate("2028-02-29", { locale: "en", style: "long" })).toBe(
      "February 29, 2028",
    );
    expect(formatDate("2028-02-30", { locale: "en", style: "iso" })).toBeNull();
    // Date would silently roll 2028-02-30 over to March 1.
    expect(
      formatDate("2028-02-30", { locale: "cs", style: "long" }),
    ).toBeNull();
  });
});

describe("renderDeterministicFieldValue", () => {
  test("formula: computes arithmetic and stringifies", () => {
    const field: DeterministicFieldConfig = {
      path: "total",
      formula: "min(rent * (1 + index / 100), rent * 1.05)",
    };
    expect(
      renderDeterministicFieldValue(field, { rent: 10_000, index: 7 }),
    ).toBe("10500");
  });

  test("formula: a non-numeric expression yields null (field left unfilled)", () => {
    const field: DeterministicFieldConfig = {
      path: "total",
      formula: "rent * 2",
    };
    expect(renderDeterministicFieldValue(field, { rent: "n/a" })).toBeNull();
  });

  test("date: formats per locale + style", () => {
    const field: DeterministicFieldConfig = {
      path: "signed",
      inputType: "date",
      dateFormat: { locale: "cs", style: "long" },
    };
    expect(renderDeterministicFieldValue(field, { signed: "2028-06-13" })).toBe(
      "13. června 2028",
    );
  });

  test("date: an empty or absent value yields null", () => {
    const field: DeterministicFieldConfig = {
      path: "signed",
      inputType: "date",
      dateFormat: { locale: "cs", style: "long" },
    };
    expect(renderDeterministicFieldValue(field, { signed: "" })).toBeNull();
    expect(renderDeterministicFieldValue(field, {})).toBeNull();
  });

  test("scalar field (no deterministic transform) yields null", () => {
    const field: DeterministicFieldConfig = {
      path: "name",
      inputType: "text",
    };
    expect(renderDeterministicFieldValue(field, { name: "Anna" })).toBeNull();
  });

  test("dispatch order: formula wins over a date rendering", () => {
    const field: DeterministicFieldConfig = {
      path: "x",
      inputType: "date",
      dateFormat: { locale: "cs", style: "long" },
      formula: "1 + 1",
    };
    expect(renderDeterministicFieldValue(field, { x: "2028-06-13" })).toBe("2");
  });
});
