import { describe, expect, test } from "bun:test";

import { assertToolInputSchema, readToolInput } from "./input";

describe("tool arguments require a directly declared object root", () => {
  test("rejects every root composition or dynamic argument source before reading", () => {
    for (const { keyword, value } of [
      { keyword: "$ref", value: "#/$defs/arguments" },
      { keyword: "$dynamicRef", value: "#arguments" },
      { keyword: "$recursiveRef", value: "#" },
      {
        keyword: "allOf",
        value: [{ properties: { name: { type: "string" } } }],
      },
      {
        keyword: "anyOf",
        value: [{ properties: { name: { type: "string" } } }],
      },
      {
        keyword: "oneOf",
        value: [{ properties: { name: { type: "string" } } }],
      },
      { keyword: "not", value: { required: ["name"] } },
      { keyword: "if", value: { required: ["name"] } },
      { keyword: "then", value: { required: ["name"] } },
      { keyword: "else", value: { required: ["name"] } },
      { keyword: "dependencies", value: { name: ["other"] } },
      { keyword: "dependentSchemas", value: { name: { required: ["other"] } } },
      { keyword: "patternProperties", value: { ".*": { type: "string" } } },
      { keyword: "unevaluatedProperties", value: true },
    ]) {
      const schema = {
        type: "object",
        properties: { name: { type: "string" } },
        [keyword]: value,
      };
      expect(() =>
        readToolInput({ schema, value: null, access: "read" }),
      ).toThrow(`root ${keyword}`);
    }
  });

  test("rejects malformed or open root argument declarations", () => {
    for (const { schema, message } of [
      { schema: {}, message: "type object" },
      { schema: { type: "string" }, message: "type object" },
      { schema: { type: ["object", "null"] }, message: "type object" },
      {
        schema: { type: "object", properties: [] },
        message: "properties must be an object",
      },
      {
        schema: { type: "object", additionalProperties: true },
        message: "undeclared root arguments",
      },
      {
        schema: { type: "object", additionalProperties: { type: "string" } },
        message: "undeclared root arguments",
      },
      {
        schema: { type: "object", required: "name" },
        message: "required must be an array",
      },
      {
        schema: { type: "object", required: [1] },
        message: "required must be an array",
      },
      {
        schema: { type: "object", required: ["name"] },
        message: "declared in root properties",
      },
    ]) {
      expect(() => assertToolInputSchema(schema)).toThrow(message);
    }
  });

  test("allows nested composition and references without changing the root argument list", () => {
    const schema = {
      type: "object",
      $defs: { name: { type: "string" } },
      properties: {
        name: { $ref: "#/$defs/name" },
        count: { allOf: [{ type: "number", minimum: 1 }] },
        choice: { anyOf: [{ type: "string" }, { type: "number" }] },
        mode: { oneOf: [{ const: "first" }, { const: "second" }] },
      },
      required: ["name"],
      additionalProperties: false,
    };
    const value = { name: "name", count: 2, choice: "choice", mode: "first" };
    const read = readToolInput({ schema, value, access: "read" });
    expect(read).toEqual({ ok: true, value, notes: [] });
  });

  test("allows zero-argument schemas and refuses undeclared arguments", () => {
    for (const schema of [
      { type: "object" },
      {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    ]) {
      expect(readToolInput({ schema, value: {}, access: "read" })).toEqual({
        ok: true,
        value: {},
        notes: [],
      });
      const read = readToolInput({
        schema,
        value: { name: "name" },
        access: "read",
      });
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.issues).toEqual([
          { path: "name", message: "Unknown parameter: name" },
        ]);
      }
    }
  });
});
