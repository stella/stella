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

  test("returns null for malformed input", () => {
    expect(
      formatDate("not-a-date", { locale: "en", style: "long" }),
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
