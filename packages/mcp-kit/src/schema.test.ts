import { describe, expect, test } from "bun:test";

import { compactSchema, hoistRepeatedSchemas } from "./schema";

const SHAPE = {
  type: "object",
  properties: { description: { type: "string" }, title: { type: "integer" } },
  required: ["description", "title"],
};

describe("schema compaction preserves constraints and instance data", () => {
  test("preserves data-valued keywords at every schema depth and reaches a fixed point", () => {
    const value = {
      description: "literal",
      title: "literal",
      default: 3,
      maximum: Number.MAX_SAFE_INTEGER,
    };
    const leaf = {
      type: "object",
      description: "guidance",
      const: value,
      enum: [value, value],
      "x-extension": { properties: { description: value } },
    };
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { description: leaf },
      dependentSchemas: { title: leaf },
      dependencies: { examples: leaf, description: ["title"] },
      allOf: [{ items: { not: leaf } }],
    };
    const compactedLeaf = {
      type: "object",
      const: value,
      enum: [value, value],
      "x-extension": { properties: { description: value } },
    };
    const compacted = compactSchema(schema);
    expect(compacted).toEqual({
      ...schema,
      properties: { description: compactedLeaf },
      dependentSchemas: { title: compactedLeaf },
      dependencies: { examples: compactedLeaf, description: ["title"] },
      allOf: [{ items: { not: compactedLeaf } }],
    });
    expect(compactSchema(compacted)).toEqual(compacted);
    expect(schema.properties.description.description).toBe("guidance");
  });

  test("retains safe-integer bounds for every numeric type", () => {
    for (const type of ["integer", "number"]) {
      const schema = { type, minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
      expect(compactSchema(schema)).toEqual(schema);
    }
  });
});

describe("schema hoisting preserves data and reference meaning", () => {
  test("never hoists repeated instance data or extension values", () => {
    const schema = {
      type: "object",
      const: SHAPE,
      enum: [SHAPE, SHAPE],
      "x-extension": { first: SHAPE, second: SHAPE },
    };
    expect(hoistRepeatedSchemas(schema, { minBytes: 1 })).toEqual(schema);
  });

  test("preserves existing definitions and avoids name collisions", () => {
    const schema = {
      type: "object",
      $defs: { first: { type: "boolean" } },
      properties: { first: SHAPE, second: SHAPE },
    };
    expect(hoistRepeatedSchemas(schema, { minBytes: 100 })).toEqual({
      ...schema,
      properties: {
        first: { $ref: "#/$defs/first2" },
        second: { $ref: "#/$defs/first2" },
      },
      $defs: { first: { type: "boolean" }, first2: SHAPE },
    });
    expect(schema.properties.first).toEqual(SHAPE);
    const hoisted = hoistRepeatedSchemas(schema, { minBytes: 100 });
    expect(hoistRepeatedSchemas(hoisted, { minBytes: 100 })).toEqual(hoisted);
  });

  test("escapes generated JSON Pointer tokens and URI fragments", () => {
    for (const { name, fragment } of [
      { name: "a/b", fragment: "a~1b" },
      { name: "a~b", fragment: "a~0b" },
      { name: "a b", fragment: "a%20b" },
      { name: "a#b", fragment: "a%23b" },
      { name: "a%b", fragment: "a%25b" },
      { name: "__proto__", fragment: "__proto__" },
    ]) {
      const schema = {
        type: "object",
        properties: { [name]: SHAPE, other: SHAPE },
      };
      expect(hoistRepeatedSchemas(schema, { minBytes: 100 })).toEqual({
        type: "object",
        properties: {
          [name]: { $ref: `#/$defs/${fragment}` },
          other: { $ref: `#/$defs/${fragment}` },
        },
        $defs: { [name]: SHAPE },
      });
    }
  });

  test("retains schemas with scope or reference keywords at nested schema positions", () => {
    for (const keyword of [
      "$schema",
      "$id",
      "id",
      "$ref",
      "$anchor",
      "$dynamicRef",
      "$dynamicAnchor",
      "$recursiveRef",
      "$recursiveAnchor",
    ]) {
      const schema = {
        type: "object",
        $defs: { target: SHAPE },
        properties: { first: SHAPE, second: SHAPE },
        allOf: [{ properties: { nested: { [keyword]: "#/$defs/target" } } }],
      };
      expect(hoistRepeatedSchemas(schema, { minBytes: 1 })).toEqual(schema);
    }
  });
});
