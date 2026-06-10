import { describe, expect, test } from "bun:test";

import {
  type DeterministicFieldConfig,
  formatDate,
  renderComposite,
  renderDeterministicFieldValue,
} from "./field-values.js";

describe("formatDate", () => {
  test("renders a locale-styled date (cs long → inflected month)", () => {
    expect(formatDate("2028-06-13", { locale: "cs", style: "long" })).toBe(
      "13. června 2028",
    );
  });

  test("'iso' style passes the value through unchanged", () => {
    expect(formatDate("2028-06-13", { locale: "cs", style: "iso" })).toBe(
      "2028-06-13",
    );
  });

  test("returns null for a malformed or non-existent calendar date", () => {
    expect(
      formatDate("not-a-date", { locale: "en", style: "long" }),
    ).toBeNull();
    expect(
      formatDate("2028-02-30", { locale: "en", style: "long" }),
    ).toBeNull();
  });
});

describe("renderComposite", () => {
  const parts = [{ key: "position" }, { key: "name" }];

  test("substitutes part values into the {{key}} format", () => {
    expect(
      renderComposite(parts, "{{position}} {{name}}", {
        position: "rad. praw.",
        name: "Jan Kowalski",
      }),
    ).toBe("rad. praw. Jan Kowalski");
  });

  test("leaves a marker as-is when its key has no part value", () => {
    expect(
      renderComposite(parts, "{{position}} {{name}}", { name: "Jan" }),
    ).toBe("{{position}} Jan");
  });

  test("leaves a marker whose key is not a declared part untouched", () => {
    expect(renderComposite(parts, "{{unknown}}", { unknown: "x" })).toBe(
      "{{unknown}}",
    );
  });
});

describe("renderDeterministicFieldValue", () => {
  test("composite: joins via the format template, not a space-join", () => {
    const field: DeterministicFieldConfig = {
      path: "lawyer",
      parts: [{ key: "position" }, { key: "name" }],
      format: "{{position}} {{name}}",
    };
    expect(
      renderDeterministicFieldValue(field, {
        lawyer: { position: "rad. praw.", name: "Jan Kowalski" },
      }),
    ).toBe("rad. praw. Jan Kowalski");
  });

  test("composite: a non-object value yields null (caller's scalar path)", () => {
    const field: DeterministicFieldConfig = {
      path: "lawyer",
      parts: [{ key: "name" }],
      format: "{{name}}",
    };
    expect(
      renderDeterministicFieldValue(field, { lawyer: "plain" }),
    ).toBeNull();
  });

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

  test("dispatch order: composite wins over formula when both present", () => {
    const field: DeterministicFieldConfig = {
      path: "x",
      parts: [{ key: "a" }],
      format: "{{a}}",
      formula: "1 + 1",
    };
    expect(
      renderDeterministicFieldValue(field, { x: { a: "composite" } }),
    ).toBe("composite");
  });
});
