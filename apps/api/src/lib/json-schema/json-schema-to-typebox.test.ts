import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { jsonSchemaToTypeBox } from "./json-schema-to-typebox";
import { toJsonSchema } from "./valibot-to-json-schema";

test("literal schemas preserve their exact value through the TypeBox adapter", () => {
  for (const literal of ["committed", 42, true]) {
    const schema = jsonSchemaToTypeBox(toJsonSchema(v.literal(literal)));
    expect(Value.Check(schema, literal)).toBe(true);
    expect(Value.Check(schema, "different")).toBe(false);
  }
});
