import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { analysisHeadingSchema } from "@stll/legal-ast/analysis";

import { strictOutputSchema } from "@/api/lib/ai-output-schema";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Collect the paths of object nodes that OpenAI strict mode would
 * reject (`additionalProperties` missing or not `false`). Walks the
 * keywords `@valibot/to-json-schema` emits.
 */
const collectLooseObjectPaths = (node: unknown, path = "$"): string[] => {
  if (!isRecord(node)) {
    return [];
  }
  const found: string[] = [];

  const isObjectNode =
    node["type"] === "object" || node["properties"] !== undefined;
  if (isObjectNode && node["additionalProperties"] !== false) {
    found.push(path);
  }

  for (const key of ["properties", "patternProperties", "$defs"]) {
    const value = node[key];
    if (!isRecord(value)) {
      continue;
    }
    for (const [childKey, child] of Object.entries(value)) {
      found.push(
        ...collectLooseObjectPaths(child, `${path}.${key}.${childKey}`),
      );
    }
  }
  for (const key of ["items", "additionalProperties", "contains"]) {
    found.push(...collectLooseObjectPaths(node[key], `${path}.${key}`));
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const value = node[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const [index, child] of value.entries()) {
      found.push(...collectLooseObjectPaths(child, `${path}.${key}[${index}]`));
    }
  }
  return found;
};

describe("strictOutputSchema", () => {
  test("pins additionalProperties: false on every nested object node", async () => {
    const schema = v.object({
      name: v.string(),
      nested: v.object({
        items: v.array(v.object({ id: v.string() })),
        choice: v.nullable(v.object({ kind: v.string() })),
      }),
      pair: v.tuple([v.object({ a: v.number() }), v.number()]),
    });

    const jsonSchema = await strictOutputSchema(schema).jsonSchema;
    expect(collectLooseObjectPaths(jsonSchema)).toEqual([]);
  });

  test("leaves an explicit additionalProperties subschema intact", async () => {
    const schema = v.record(v.string(), v.object({ id: v.string() }));

    const jsonSchema = await strictOutputSchema(schema).jsonSchema;
    if (typeof jsonSchema.additionalProperties !== "object") {
      throw new TypeError("expected record value subschema to be preserved");
    }
    // The record's value schema is still strictified inside.
    expect(jsonSchema.additionalProperties.additionalProperties).toBe(false);
  });

  test("makes the case-law analysis heading schema strict-compatible", async () => {
    // Regression: analysisHeadingSchema uses plain v.object() and
    // 400ed on OpenAI as the Output.array element schema.
    const jsonSchema = await strictOutputSchema(analysisHeadingSchema)
      .jsonSchema;
    expect(collectLooseObjectPaths(jsonSchema)).toEqual([]);
  });

  test("validates values with the original valibot semantics", async () => {
    const schema = v.object({
      text: v.pipe(v.string(), v.minLength(1)),
    });
    const { validate } = strictOutputSchema(schema);
    if (validate === undefined) {
      throw new Error("expected a validate function");
    }

    expect(await validate({ text: "ok" })).toEqual({
      success: true,
      value: { text: "ok" },
    });
    expect((await validate({ text: "" })).success).toBe(false);
  });
});
