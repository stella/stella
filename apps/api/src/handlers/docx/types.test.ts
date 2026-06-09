import { describe, expect, test } from "bun:test";

import { isFieldMeta, isTemplateDataValue } from "@/api/handlers/docx/types";

const createNestedObject = (depth: number): unknown => {
  let value: unknown = "leaf";

  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }

  return value;
};

describe("isTemplateDataValue", () => {
  test("rejects excessively deep nested values instead of recursing forever", () => {
    expect(isTemplateDataValue(createNestedObject(128))).toBe(false);
  });

  test("accepts ordinary nested values within the depth budget", () => {
    expect(
      isTemplateDataValue({
        matter: {
          client: {
            name: "Ada",
          },
        },
      }),
    ).toBe(true);
  });
});

describe("isFieldMeta", () => {
  const compositeField = {
    path: "lawyer",
    parts: [
      { key: "position", inputType: "select", options: ["adw."] },
      { key: "name", inputType: "text" },
    ],
    format: "{{position}} {{name}}",
  };

  test("accepts a composite field with parts and format", () => {
    expect(isFieldMeta(compositeField)).toBe(true);
  });

  test("rejects parts without format (and vice versa)", () => {
    const { format: _format, ...partsOnly } = compositeField;
    expect(isFieldMeta(partsOnly)).toBe(false);
    const { parts: _parts, ...formatOnly } = compositeField;
    expect(isFieldMeta(formatOnly)).toBe(false);
  });

  test("rejects an empty parts array", () => {
    expect(isFieldMeta({ ...compositeField, parts: [] })).toBe(false);
  });

  test("rejects a part key outside the field-path charset", () => {
    expect(
      isFieldMeta({
        ...compositeField,
        parts: [{ key: "bad key!", inputType: "text" }],
      }),
    ).toBe(false);
  });

  test("rejects a part with an unknown inputType", () => {
    expect(
      isFieldMeta({
        ...compositeField,
        parts: [{ key: "position", inputType: "date" }],
      }),
    ).toBe(false);
  });
});
