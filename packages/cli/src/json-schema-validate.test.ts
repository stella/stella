import { describe, expect, test } from "bun:test";

import { validateAgainstSchema } from "./json-schema-validate.js";

const objectSchema = (
  properties: Record<string, unknown>,
  required?: string[],
) => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
});

describe("validateAgainstSchema (interpreted, no codegen)", () => {
  test("accepts a well-formed object", () => {
    const schema = objectSchema(
      {
        matter_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["matter_id"],
    );
    expect(
      validateAgainstSchema(schema, { matter_id: "m1", limit: 5 }),
    ).toEqual({
      valid: true,
    });
  });

  test("reports a missing required property with its path", () => {
    const schema = objectSchema({ matter_id: { type: "string" } }, [
      "matter_id",
    ]);
    const result = validateAgainstSchema(schema, {});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.path).toBe("matter_id");
    }
  });

  test("enforces integer bounds", () => {
    const schema = objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 10 },
    });
    expect(validateAgainstSchema(schema, { limit: 11 }).valid).toBe(false);
    expect(validateAgainstSchema(schema, { limit: 1.5 }).valid).toBe(false);
    expect(validateAgainstSchema(schema, { limit: 5 }).valid).toBe(true);
  });

  test("accepts null only for a nullable type", () => {
    const nullable = objectSchema({ x: { type: ["string", "null"] } });
    const plain = objectSchema({ x: { type: "string" } });
    expect(validateAgainstSchema(nullable, { x: null }).valid).toBe(true);
    expect(validateAgainstSchema(plain, { x: null }).valid).toBe(false);
  });

  test("validates enum membership", () => {
    const schema = objectSchema({
      type: { type: "string", enum: ["person", "organization"] },
    });
    expect(validateAgainstSchema(schema, { type: "person" }).valid).toBe(true);
    expect(validateAgainstSchema(schema, { type: "robot" }).valid).toBe(false);
  });

  test("enforces string length and pattern constraints", () => {
    const schema = objectSchema({
      lawId: {
        type: "string",
        minLength: 12,
        maxLength: 32,
        pattern: "^BOE-[A-Z]-\\d{4}-\\d+$",
      },
    });

    expect(validateAgainstSchema(schema, { lawId: "BOE-A-2026-1" }).valid).toBe(
      true,
    );
    expect(validateAgainstSchema(schema, { lawId: "xxxxx" }).valid).toBe(false);
    expect(
      validateAgainstSchema(schema, { lawId: `BOE-A-2026-${"1".repeat(30)}` })
        .valid,
    ).toBe(false);
  });

  test("validates arrays and their items with minItems", () => {
    const schema = objectSchema({
      jurisdictions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            countryCode: { type: "string" },
            isPrimary: { type: "boolean" },
          },
          required: ["countryCode", "isPrimary"],
        },
      },
    });
    expect(
      validateAgainstSchema(schema, {
        jurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      }).valid,
    ).toBe(true);
    expect(validateAgainstSchema(schema, { jurisdictions: [] }).valid).toBe(
      false,
    );
    expect(
      validateAgainstSchema(schema, {
        jurisdictions: [{ countryCode: "CZ" }],
      }).valid,
    ).toBe(false);
  });

  test("allows arbitrary keys under a free map (additionalProperties)", () => {
    const schema = objectSchema({
      values: { type: "object", additionalProperties: true },
    });
    expect(
      validateAgainstSchema(schema, { values: { anything: 1, x: "y" } }).valid,
    ).toBe(true);
  });

  test("rejects an unknown property against a closed object", () => {
    const schema = objectSchema({ matter_id: { type: "string" } });
    expect(
      validateAgainstSchema(schema, { matter_id: "m", bogus: 1 }).valid,
    ).toBe(false);
  });

  test("a typeless child schema accepts any value (set_field_value.content.value)", () => {
    const schema = objectSchema({
      content: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["text", "int"] },
          value: { description: "any" },
        },
        required: ["type", "value"],
      },
    });
    expect(
      validateAgainstSchema(schema, {
        content: { type: "int", value: 42 },
      }).valid,
    ).toBe(true);
  });
});
