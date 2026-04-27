import { toJsonSchema } from "@valibot/to-json-schema";
import type { JsonSchema } from "@valibot/to-json-schema";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  jsonSchemaToAsyncFnType,
  jsonSchemaToType,
} from "./json-schema-to-type";

describe("jsonSchemaToType", () => {
  test("renders primitive schemas", () => {
    expect(jsonSchemaToType({ type: "string" })).toBe("string");
    expect(jsonSchemaToType({ type: "number" })).toBe("number");
    expect(jsonSchemaToType({ type: "integer" })).toBe("number");
    expect(jsonSchemaToType({ type: "boolean" })).toBe("boolean");
    expect(jsonSchemaToType({ type: "null" })).toBe("null");
    expect(jsonSchemaToType({})).toBe("unknown");
  });

  test("renders strict objects with required and optional properties", () => {
    const schema = toJsonSchema(
      v.strictObject({
        foo: v.string(),
        bar: v.optional(v.number()),
      }),
      { errorMode: "ignore", target: "draft-07" },
    );

    expect(jsonSchemaToType(schema)).toBe(`{
  foo: string;
  bar?: number;
}`);
  });

  test("renders object schemas with rest properties", () => {
    const schema = toJsonSchema(
      v.objectWithRest(
        {
          foo: v.string(),
        },
        v.number(),
      ),
      { errorMode: "ignore", target: "draft-07" },
    );

    expect(jsonSchemaToType(schema)).toBe(`{
  foo: string;
  [key: string]: number;
}`);
  });

  test("renders record-like object schemas", () => {
    const schema = toJsonSchema(v.record(v.string(), v.boolean()), {
      errorMode: "ignore",
      target: "draft-07",
    });

    expect(jsonSchemaToType(schema)).toBe("Record<string, boolean>");
  });

  test("renders arrays and tuples", () => {
    const arraySchema = toJsonSchema(
      v.array(
        v.strictObject({
          id: v.string(),
        }),
      ),
      { errorMode: "ignore", target: "draft-07" },
    );
    const tupleSchema = toJsonSchema(v.strictTuple([v.string(), v.number()]), {
      errorMode: "ignore",
      target: "draft-07",
    });
    const tupleWithRestSchema = toJsonSchema(
      v.tupleWithRest([v.string()], v.number()),
      { errorMode: "ignore", target: "draft-07" },
    );

    expect(jsonSchemaToType(arraySchema)).toBe(`Array<{
  id: string;
}>`);
    expect(jsonSchemaToType(tupleSchema)).toBe("[string, number]");
    expect(jsonSchemaToType(tupleWithRestSchema)).toBe("[string, ...number[]]");
  });

  test("renders enums as literal unions", () => {
    const stringEnumSchema = toJsonSchema(v.picklist(["a", "b"] as const), {
      errorMode: "ignore",
      target: "draft-07",
    });
    const numberEnumSchema = {
      enum: [1, 2, 3],
      $schema: "http://json-schema.org/draft-07/schema#",
    };

    expect(jsonSchemaToType(stringEnumSchema)).toBe('"a" | "b"');
    expect(jsonSchemaToType(numberEnumSchema)).toBe("1 | 2 | 3");
  });

  test("renders supported const schemas as literals", () => {
    const schema = toJsonSchema(v.literal("x"), {
      errorMode: "ignore",
      target: "draft-07",
    });

    expect(jsonSchemaToType(schema)).toBe('"x"');
  });

  test("renders intersections from allOf", () => {
    const schema = toJsonSchema(
      v.intersect([
        v.object({ foo: v.string() }),
        v.object({ bar: v.number() }),
      ]),
      { errorMode: "ignore", target: "draft-07" },
    );

    expect(jsonSchemaToType(schema)).toBe(`{
  foo: string;
} & {
  bar: number;
}`);
  });

  test("degrades ref-based schemas to unknown", () => {
    const schema = {
      $defs: {
        Node: {
          properties: {
            next: { $ref: "#/$defs/Node" },
            value: { type: "string" },
          },
          required: ["value"],
          type: "object",
        },
      },
      $ref: "#/$defs/Node",
      $schema: "http://json-schema.org/draft-07/schema#",
    } satisfies JsonSchema;

    expect(jsonSchemaToType(schema)).toBe("unknown");
  });

  test("renders direct union-like schemas", () => {
    const nullableSchema = toJsonSchema(v.nullable(v.string()), {
      errorMode: "ignore",
      target: "draft-07",
    });
    const variantSchema = toJsonSchema(
      v.variant("type", [
        v.object({
          type: v.literal("a"),
          value: v.string(),
        }),
        v.object({
          type: v.literal("b"),
          value: v.number(),
        }),
      ]),
      { errorMode: "ignore", target: "draft-07" },
    );

    expect(jsonSchemaToType(nullableSchema)).toBe("string | null");
    expect(jsonSchemaToType(variantSchema)).toBe(`{
  type: "a";
  value: string;
} | {
  type: "b";
  value: number;
}`);
  });

  test("degrades unsupported schemas to unknown", () => {
    expect(jsonSchemaToType({ if: { type: "string" } })).toBe("unknown");
  });
});

describe("jsonSchemaToAsyncFnType", () => {
  test("renders a full function signature", () => {
    const signature = jsonSchemaToAsyncFnType({
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          entityId: { type: "string" },
        },
        required: ["workspaceId", "entityId"],
      },
      name: "readContent",
      outputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          truncated: { type: "boolean" },
        },
        required: ["text", "truncated"],
      },
    });

    expect(signature).toBe(`readContent(input: {
  workspaceId: string;
  entityId: string;
}): Promise<{
  text: string;
  truncated: boolean;
}>`);
  });
});
