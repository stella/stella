import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { safeIdSchema } from "@stll/api-contract/safe-id";

import { toTanStackValibotSchema } from "./tanstack-ai-schema";

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
});
