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

  test("accepts optionsFrom holding a field path", () => {
    expect(
      isFieldMeta({
        path: "lead_party",
        inputType: "select",
        optionsFrom: "parties.name",
      }),
    ).toBe(true);
  });

  test("rejects optionsFrom outside the field-path grammar", () => {
    expect(
      isFieldMeta({ path: "lead_party", optionsFrom: "parties[0].name" }),
    ).toBe(false);
    expect(isFieldMeta({ path: "lead_party", optionsFrom: 7 })).toBe(false);
  });

  test("accepts a lookup with a supported registry, aiFormat optional", () => {
    expect(
      isFieldMeta({ path: "buyer_krs", lookup: { registry: "krs" } }),
    ).toBe(true);
    expect(
      isFieldMeta({
        path: "buyer_krs",
        lookup: { registry: "krs", aiFormat: "[name], KRS [number]" },
      }),
    ).toBe(true);
  });

  test("rejects a lookup with an unsupported registry or bad shape", () => {
    expect(
      isFieldMeta({ path: "buyer_krs", lookup: { registry: "unknown" } }),
    ).toBe(false);
    expect(isFieldMeta({ path: "buyer_krs", lookup: { registry: 7 } })).toBe(
      false,
    );
    expect(isFieldMeta({ path: "buyer_krs", lookup: "krs" })).toBe(false);
    expect(
      isFieldMeta({
        path: "buyer_krs",
        lookup: { registry: "krs", aiFormat: 7 },
      }),
    ).toBe(false);
  });

  test("accepts a formula field", () => {
    expect(isFieldMeta({ path: "rent_annual", formula: "rent * 12" })).toBe(
      true,
    );
  });

  test("rejects a non-string formula", () => {
    expect(isFieldMeta({ path: "rent_annual", formula: 12 })).toBe(false);
  });

  test("rejects a formula combined with another value source", () => {
    expect(
      isFieldMeta({ path: "x", formula: "rent * 12", aiPrompt: "draft it" }),
    ).toBe(false);
    expect(
      isFieldMeta({ path: "x", formula: "rent * 12", aiAdapt: true }),
    ).toBe(false);
    expect(
      isFieldMeta({
        path: "x",
        formula: "rent * 12",
        lookup: { registry: "krs" },
      }),
    ).toBe(false);
    expect(isFieldMeta({ ...compositeField, formula: "rent * 12" })).toBe(
      false,
    );
  });

  test("accepts a date field with a dateFormat", () => {
    expect(
      isFieldMeta({
        path: "signature_date",
        inputType: "date",
        dateFormat: { locale: "cs", style: "long" },
      }),
    ).toBe(true);
    expect(
      isFieldMeta({
        path: "signature_date",
        inputType: "date",
        dateFormat: { locale: "pt-BR", style: "iso" },
      }),
    ).toBe(true);
  });

  test("rejects a dateFormat with an unknown style or bad shape", () => {
    expect(
      isFieldMeta({
        path: "signature_date",
        dateFormat: { locale: "cs", style: "fancy" },
      }),
    ).toBe(false);
    expect(
      isFieldMeta({ path: "signature_date", dateFormat: { locale: "cs" } }),
    ).toBe(false);
    expect(isFieldMeta({ path: "signature_date", dateFormat: "long" })).toBe(
      false,
    );
  });

  test("rejects a dateFormat whose locale is not a plausible BCP-47 tag", () => {
    expect(
      isFieldMeta({
        path: "signature_date",
        dateFormat: { locale: "not a locale", style: "long" },
      }),
    ).toBe(false);
    expect(
      isFieldMeta({
        path: "signature_date",
        dateFormat: { locale: "", style: "long" },
      }),
    ).toBe(false);
    expect(
      isFieldMeta({
        path: "signature_date",
        dateFormat: { locale: 7, style: "long" },
      }),
    ).toBe(false);
  });
});
