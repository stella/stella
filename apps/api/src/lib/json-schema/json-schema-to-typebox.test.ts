import { TypeCompiler } from "@sinclair/typebox/compiler";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { jsonSchemaToTypeBox } from "./json-schema-to-typebox";
import { toJsonSchema } from "./valibot-to-json-schema";

test("primitive JSON constants compile and accept exactly their declared value", () => {
  const values = ["literal", 42, true, false, null];
  for (const value of values) {
    const validator = TypeCompiler.Compile(
      jsonSchemaToTypeBox({ const: value }),
    );
    for (const candidate of values) {
      expect(validator.Check(candidate)).toBe(candidate === value);
    }
  }
  for (const value of [[], {}]) {
    expect(() => jsonSchemaToTypeBox({ const: value })).toThrow(
      "The TypeBox adapter requires primitive constant values",
    );
  }
});

test("Valibot discriminated unions compile with exclusive native branch validation", () => {
  const schema = v.strictObject({
    values: v.array(
      v.union([
        v.strictObject({ type: v.literal("text"), value: v.string() }),
        v.strictObject({ type: v.literal("number"), value: v.number() }),
      ]),
    ),
  });
  const validator = TypeCompiler.Compile(
    jsonSchemaToTypeBox(toJsonSchema(schema)),
  );
  expect(
    validator.Check({
      values: [
        { type: "text", value: "literal" },
        { type: "number", value: 42 },
      ],
    }),
  ).toBe(true);
  for (const value of [
    { type: "text", value: 42 },
    { type: "number", value: "literal" },
    { type: "unknown", value: "literal" },
    { type: "text", value: "literal", extra: true },
  ]) {
    expect(validator.Check({ values: [value] })).toBe(false);
  }
});
