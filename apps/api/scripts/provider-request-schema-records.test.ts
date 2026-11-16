import { expect, test } from "bun:test";

import { isRecord } from "@/api/lib/type-guards";

import { extractRequestSchema } from "./provider-request-schemas";

const names = ["__proto__", "constructor", "toString", "ordinary"];

const recordOf = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new TypeError("Expected a schema record");
  }
  return value;
};

const extractOpenApiBody = (body: Record<string, unknown>) => {
  const schema = extractRequestSchema(
    {
      paths: {
        "/request": {
          post: {
            requestBody: { content: { "application/json": { schema: body } } },
          },
        },
      },
      components: { schemas: {} },
    },
    { format: "openapi", method: "post", path: "/request" },
  );
  return recordOf(recordOf(schema["$defs"])["RequestBody"]);
};

test.each(names)(
  "OpenAPI rewriting retains the own %s schema keyword",
  (name) => {
    const value = { marker: "retained" };
    const result = extractOpenApiBody({
      type: "object",
      nullable: true,
      [name]: value,
      properties: Object.fromEntries([[name, { type: "string" }]]),
    });
    expect(Object.getOwnPropertyDescriptor(result, name)?.value).toEqual(value);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result["type"]).toEqual(["object", "null"]);
    expect(
      Object.getOwnPropertyDescriptor(recordOf(result["properties"]), name)
        ?.value,
    ).toEqual({ type: "string" });
    const serialized = JSON.stringify(result);
    expect(JSON.parse(serialized)).toEqual(result);
  },
);

for (const renamed of [false, true]) {
  test.each(names)(
    `AWS ${renamed ? "renamed" : "direct"} body members retain the own %s name`,
    (name) => {
      const memberName = renamed ? "inputMember" : name;
      const schema = extractRequestSchema(
        {
          operations: { Send: { input: { shape: "Input" } } },
          shapes: {
            Input: {
              type: "structure",
              union: true,
              members: Object.fromEntries([
                [
                  memberName,
                  { shape: "Text", ...(renamed ? { locationName: name } : {}) },
                ],
                ["headerOnly", { shape: "Text", location: "header" }],
              ]),
              required: [memberName, "headerOnly"],
            },
            Text: { type: "string" },
          },
        },
        { format: "aws-service-model", operation: "Send" },
      );
      const input = recordOf(recordOf(schema["$defs"])["Input"]);
      const properties = recordOf(input["properties"]);
      expect(Object.keys(properties)).toEqual([name]);
      expect(Object.getOwnPropertyDescriptor(properties, name)?.value).toEqual({
        $ref: "#/$defs/Text",
      });
      expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
      expect(input["required"]).toEqual([name]);
      expect(input["minProperties"]).toBe(1);
      expect(input["maxProperties"]).toBe(1);
      const serialized = JSON.stringify(schema);
      expect(JSON.parse(serialized)).toEqual(schema);
    },
  );
}

test("OpenAPI alternatives retain conjunctions regardless of keyword order", () => {
  const branches = {
    allOf: [{ minProperties: 1 }],
    anyOf: [{ required: ["first"] }, { required: ["second"] }],
    oneOf: [{ required: ["third"] }, { required: ["fourth"] }],
  };
  const keys = ["allOf", "anyOf", "oneOf"] as const;
  for (const first of keys) {
    for (const second of keys) {
      if (first === second) {
        continue;
      }
      const third = keys.find((key) => key !== first && key !== second);
      if (third === undefined) {
        throw new TypeError("Missing third branch");
      }
      const order = [first, second, third];
      const result = extractOpenApiBody(
        Object.fromEntries(order.map((key) => [key, branches[key]])),
      );
      expect({ order, result }).toEqual({
        order,
        result: {
          allOf: [...branches.allOf, { anyOf: branches.oneOf }],
          anyOf: branches.anyOf,
        },
      });
    }
  }
});

test("OpenAPI annotations and unusable patterns stay excluded while nullability survives", () => {
  expect(
    extractOpenApiBody({
      type: "string",
      nullable: true,
      description: "annotation",
      default: "annotation",
      "x-extension": { ignored: true },
      pattern: "[",
      minLength: 2,
    }),
  ).toEqual({ type: ["string", "null"], minLength: 2 });
});
