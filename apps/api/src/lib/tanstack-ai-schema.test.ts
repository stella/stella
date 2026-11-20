import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { safeIdSchema } from "@stll/api-contract/safe-id";

import {
  projectSchemaInputJsonSchema,
  toTanStackValibotSchema,
} from "./tanstack-ai-schema";

describe("tool validation projection", () => {
  test("omits only the explicitly selected validation action", async () => {
    const canonical = v.strictObject({
      value: v.pipe(
        v.number(),
        v.minValue(1),
        v.check((value) => value % 2 === 0),
      ),
    });
    expect(() =>
      convertSchemaToJsonSchema(toTanStackValibotSchema(canonical)),
    ).toThrow('"check" action');
    const projected = toTanStackValibotSchema(canonical, {
      omitValidationActions: ["check"],
    });
    expect(convertSchemaToJsonSchema(projected)).toMatchObject({
      properties: { value: { type: "number", minimum: 1 } },
    });
    expect(await projected["~standard"].validate({ value: 3 })).toHaveProperty(
      "issues",
    );
    expect(await projected["~standard"].validate({ value: 4 })).toMatchObject({
      value: { value: 4 },
    });
    const anotherAction = v.strictObject({
      value: v.pipe(
        v.string(),
        v.check((value) => value.length > 0),
        v.toUpperCase(),
      ),
    });
    expect(() =>
      convertSchemaToJsonSchema(
        toTanStackValibotSchema(anotherAction, {
          omitValidationActions: ["check"],
        }),
      ),
    ).toThrow('"to_upper_case" action');
  });

  test("projects explicitly omitted brands as their base type and retains canonical validation", async () => {
    const canonical = v.strictObject({
      id: v.pipe(safeIdSchema, v.maxLength(256)),
    });
    expect(() =>
      convertSchemaToJsonSchema(
        toTanStackValibotSchema(canonical, {
          omitValidationActions: ["check"],
        }),
      ),
    ).toThrow('"brand" action');
    const projected = toTanStackValibotSchema(canonical, {
      omitValidationActions: ["check", "brand"],
    });
    expect(convertSchemaToJsonSchema(projected)).toMatchObject({
      properties: { id: { type: "string", maxLength: 256 } },
    });
    expect(await projected["~standard"].validate({ id: "" })).toHaveProperty(
      "issues",
    );
    expect(
      await projected["~standard"].validate({ id: "case-one" }),
    ).toMatchObject({
      value: { id: v.parse(safeIdSchema, "case-one") },
    });
    const transformation = v.strictObject({
      id: v.pipe(v.string(), v.brand("Id"), v.toUpperCase()),
    });
    expect(() =>
      convertSchemaToJsonSchema(
        toTanStackValibotSchema(transformation, {
          omitValidationActions: ["check", "brand"],
        }),
      ),
    ).toThrow('"to_upper_case" action');
  });

  test("preserves the ordinary tool schema snapshot", () => {
    const canonical = v.strictObject({
      answer: v.pipe(v.string(), v.minLength(1)),
    });
    const expected = {
      type: "object",
      properties: { answer: { type: "string", minLength: 1 } },
      required: ["answer"],
      additionalProperties: false,
    };
    expect(
      convertSchemaToJsonSchema(toTanStackValibotSchema(canonical)),
    ).toEqual(expected);
    expect(
      convertSchemaToJsonSchema(
        toTanStackValibotSchema(canonical, { omitValidationActions: [] }),
      ),
    ).toEqual(expected);
  });
  test("projects a frozen nested schema without changing its source or explicit object policy", () => {
    const rawSchema = Object.freeze({
      type: "object",
      properties: Object.freeze({
        rows: Object.freeze({
          type: "array",
          items: Object.freeze({
            type: "object",
            properties: Object.freeze({
              label: Object.freeze({ type: "string" }),
            }),
          }),
        }),
        choice: Object.freeze({
          anyOf: Object.freeze([
            Object.freeze({ type: "object", additionalProperties: true }),
            Object.freeze({ type: "null" }),
          ]),
        }),
        closed: Object.freeze({ type: "object", additionalProperties: false }),
      }),
      required: Object.freeze(["rows", "choice"]),
    });
    const before = JSON.stringify(rawSchema);
    const canonical = toTanStackValibotSchema(
      v.object({
        rows: v.array(v.object({ label: v.string() })),
        choice: v.nullable(v.looseObject({})),
        closed: v.optional(v.strictObject({})),
      }),
    );
    const projected = projectSchemaInputJsonSchema(
      {
        "~standard": {
          ...canonical["~standard"],
          jsonSchema: { input: () => rawSchema, output: () => rawSchema },
        },
      },
      { nullUnionStrategy: "json-schema" },
    );
    const output = convertSchemaToJsonSchema(projected);
    const expected = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" } },
            additionalProperties: false,
          },
        },
        choice: {
          anyOf: [
            { type: "object", additionalProperties: true },
            { type: "null" },
          ],
        },
        closed: { type: "object", additionalProperties: false },
      },
      required: ["rows", "choice"],
      additionalProperties: false,
    };
    expect(output).toEqual(expected);
    expect(JSON.stringify(output)).toBe(JSON.stringify(expected));
    expect(JSON.stringify(rawSchema)).toBe(before);
    expect(projected).toHaveProperty(
      "~standard.validate",
      canonical["~standard"].validate,
    );
  });
});
