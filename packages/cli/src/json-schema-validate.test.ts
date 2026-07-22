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

  test("validates discriminated anyOf branches and const values", () => {
    const schema = objectSchema({
      body: {
        anyOf: [
          {
            type: "object",
            properties: {
              purpose: { type: "string", const: "entity_create" },
              propertyId: { type: "string" },
            },
            required: ["purpose", "propertyId"],
          },
          {
            type: "object",
            properties: {
              purpose: { type: "string", const: "entity_version" },
              entityId: { type: "string" },
            },
            required: ["purpose", "entityId"],
          },
        ],
      },
    });

    expect(
      validateAgainstSchema(schema, {
        body: { purpose: "entity_create", propertyId: "p1" },
      }).valid,
    ).toBe(true);
    expect(
      validateAgainstSchema(schema, {
        body: { purpose: "entity_create" },
      }).valid,
    ).toBe(false);
    expect(
      validateAgainstSchema(schema, {
        body: { purpose: "unknown", propertyId: "p1" },
      }).valid,
    ).toBe(false);
  });

  test("composes shared object fields with matching alternative branches", () => {
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const schema = {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
        [keyword]: [
          objectSchema(
            {
              kind: { type: "string", const: "a" },
              aValue: { type: "number" },
            },
            ["kind", "aValue"],
          ),
          objectSchema(
            {
              kind: { type: "string", const: "b" },
              bValue: { type: "boolean" },
            },
            ["kind", "bValue"],
          ),
        ],
      };

      expect(
        validateAgainstSchema(schema, {
          token: "shared",
          kind: "a",
          aValue: 1,
        }).valid,
      ).toBe(true);
      expect(
        validateAgainstSchema(schema, {
          token: "shared",
          kind: "a",
          aValue: 1,
          bValue: true,
        }).valid,
      ).toBe(false);
      expect(
        validateAgainstSchema(schema, {
          token: "shared",
          kind: "a",
          aValue: 1,
          unexpected: true,
        }).valid,
      ).toBe(false);
    }
  });

  test("requires every allOf branch and compares structured const values", () => {
    const schema = {
      allOf: [
        objectSchema({ version: { type: "number", const: 1 } }, ["version"]),
        objectSchema({
          config: { const: { enabled: true, labels: ["a", "b"] } },
        }),
      ],
    };

    expect(
      validateAgainstSchema(schema, {
        version: 1,
        config: { labels: ["a", "b"], enabled: true },
      }).valid,
    ).toBe(true);
    expect(
      validateAgainstSchema(schema, {
        version: 2,
        config: { labels: ["a", "b"], enabled: true },
      }).valid,
    ).toBe(false);
  });

  test("enforces typeless object constraints nested through allOf", () => {
    const schema = {
      allOf: [
        {
          allOf: [{ required: ["dependencies"] }],
        },
      ],
    };

    expect(validateAgainstSchema(schema, {}).valid).toBe(false);
    expect(
      validateAgainstSchema(schema, { dependencies: ["matter"] }).valid,
    ).toBe(true);
    // Object-only keywords do not turn a typeless schema into an object type.
    expect(validateAgainstSchema(schema, "unconstrained scalar").valid).toBe(
      true,
    );
  });

  test("preserves explicit object closure inside allOf branches", () => {
    const closedBranch = {
      allOf: [
        {
          ...objectSchema({ allowed: { type: "string" } }),
          additionalProperties: false,
        },
      ],
    };
    expect(
      validateAgainstSchema(closedBranch, {
        allowed: "yes",
        unexpected: true,
      }).valid,
    ).toBe(false);

    const siblingProperties = {
      allOf: [
        objectSchema({ first: { type: "string" } }, ["first"]),
        objectSchema({ second: { type: "string" } }, ["second"]),
      ],
    };
    expect(
      validateAgainstSchema(siblingProperties, {
        first: "one",
        second: "two",
      }).valid,
    ).toBe(true);
  });

  test("implicitly closed objects accept allOf-declared properties only", () => {
    const composed = {
      ...objectSchema({ base: { type: "string" } }, ["base"]),
      allOf: [objectSchema({ composed: { type: "number" } }, ["composed"])],
    };

    expect(
      validateAgainstSchema(composed, { base: "value", composed: 1 }).valid,
    ).toBe(true);
    expect(
      validateAgainstSchema(composed, { base: "value", unexpected: 1 }).valid,
    ).toBe(false);

    expect(
      validateAgainstSchema(
        { ...composed, additionalProperties: false },
        { base: "value", composed: 1 },
      ).valid,
    ).toBe(false);
  });

  test("allOf-only objects close over the union of branch properties", () => {
    const composed = {
      allOf: [
        objectSchema({ first: { type: "string" } }, ["first"]),
        objectSchema({ second: { type: "number" } }, ["second"]),
      ],
    };

    expect(
      validateAgainstSchema(composed, { first: "value", second: 1 }).valid,
    ).toBe(true);
    expect(
      validateAgainstSchema(composed, {
        first: "value",
        second: 1,
        unexpected: true,
      }).valid,
    ).toBe(false);
  });

  test("requires exactly one matching oneOf branch", () => {
    const schema = objectSchema({
      value: {
        oneOf: [
          { type: "string", pattern: "^a" },
          { type: "string", pattern: "z$" },
        ],
      },
    });

    expect(validateAgainstSchema(schema, { value: "apple" }).valid).toBe(true);
    expect(validateAgainstSchema(schema, { value: "middle" })).toEqual({
      valid: false,
      path: "value",
      message: "value must match exactly one schema (matched 0)",
    });
    expect(validateAgainstSchema(schema, { value: "az" })).toEqual({
      valid: false,
      path: "value",
      message: "value must match exactly one schema (matched 2)",
    });
  });

  test("enforces string length and pattern constraints", () => {
    const schema = objectSchema({
      lawId: {
        type: "string",
        minLength: 13,
        maxLength: 32,
        pattern: "^BOE-[A-Z]-\\d{4}-\\d+$",
      },
    });

    expect(
      validateAgainstSchema(schema, { lawId: "BOE-A-2026-12" }).valid,
    ).toBe(true);
    expect(validateAgainstSchema(schema, { lawId: "BOE-A-2026-1" }).valid).toBe(
      false,
    );
    expect(
      validateAgainstSchema(schema, { lawId: "xxxxxxxxxxxxx" }).valid,
    ).toBe(false);
    expect(
      validateAgainstSchema(schema, {
        lawId: `BOE-A-2026-${"1".repeat(30)}`,
      }).valid,
    ).toBe(false);
  });

  test("counts minLength and maxLength in Unicode code points", () => {
    const schema = objectSchema({
      value: { type: "string", minLength: 2, maxLength: 2 },
    });

    expect(validateAgainstSchema(schema, { value: "😀a" }).valid).toBe(true);
    expect(validateAgainstSchema(schema, { value: "😀" }).valid).toBe(false);
    expect(validateAgainstSchema(schema, { value: "😀ab" }).valid).toBe(false);
  });

  test("returns a validation issue for an invalid schema pattern", () => {
    const schema = objectSchema({
      value: { type: "string", pattern: "[" },
    });

    expect(validateAgainstSchema(schema, { value: "anything" })).toEqual({
      valid: false,
      path: "value",
      message: "schema contains an invalid string pattern",
    });
  });

  test("validates serialized RegExp schemas with the shared safe engine", () => {
    const schema = objectSchema({
      checksum: { type: "RegExp", source: "^[0-9a-f]{64}$", flags: "iu" },
    });

    expect(
      validateAgainstSchema(schema, { checksum: "A".repeat(64) }).valid,
    ).toBe(true);
    expect(validateAgainstSchema(schema, { checksum: "nope" }).valid).toBe(
      false,
    );

    const invalidFlags = objectSchema({
      checksum: { type: "RegExp", source: ".*", flags: "x" },
    });
    expect(
      validateAgainstSchema(invalidFlags, { checksum: "anything" }).valid,
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

  test("validates matching pattern properties before additional properties", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^x-": { type: "string" },
      },
      additionalProperties: false,
    };

    expect(validateAgainstSchema(schema, { "x-name": "valid" }).valid).toBe(
      true,
    );
    expect(validateAgainstSchema(schema, { "x-name": 42 }).valid).toBe(false);
    expect(validateAgainstSchema(schema, { other: "value" }).valid).toBe(false);

    const composed = {
      type: "object",
      properties: {
        "x-name": { type: "string", minLength: 5 },
      },
      patternProperties: {
        "^x-": { type: "string" },
        name$: { type: "string", pattern: "^valid$" },
      },
      additionalProperties: false,
    };
    expect(validateAgainstSchema(composed, { "x-name": "valid" }).valid).toBe(
      true,
    );
    expect(validateAgainstSchema(composed, { "x-name": "wrong" }).valid).toBe(
      false,
    );
  });

  test("rejects malformed pattern properties even for an empty object", () => {
    expect(
      validateAgainstSchema(
        {
          type: "object",
          patternProperties: { "[": { type: "string" } },
        },
        {},
      ).valid,
    ).toBe(false);
    expect(
      validateAgainstSchema(
        {
          type: "object",
          patternProperties: { "^x-": "not-a-schema" },
        },
        {},
      ).valid,
    ).toBe(false);
    expect(
      validateAgainstSchema(
        {
          type: "object",
          patternProperties: "not-an-object",
        },
        {},
      ).valid,
    ).toBe(false);
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
