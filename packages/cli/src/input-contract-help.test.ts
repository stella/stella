import { describe, expect, test } from "bun:test";

import { generatedRouteMap } from "./generated/route-map.js";
import {
  buildInputContractHelp,
  formatInputExample,
} from "./input-contract-help.js";
import { validateAgainstSchema } from "./json-schema-validate.js";
import type { JsonSchema, RouteNode } from "./route-types.js";

const completeExample = (
  help: ReturnType<typeof buildInputContractHelp>,
): Record<string, unknown> => {
  expect(help?.example.status).toBe("complete");
  if (help?.example.status !== "complete") {
    throw new Error("Expected a complete input example");
  }
  return help.example.value;
};

describe("--input contract help", () => {
  test("renders free maps with a deterministic valid example", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        template_id: { type: "string" },
        values: {
          type: "object",
          description: "Map of field path to value.",
          additionalProperties: true,
        },
      },
      required: ["template_id", "values"],
    };

    const help = buildInputContractHelp({
      schema,
      inputOnly: ["values"],
      requiredPaths: ["template_id"],
    });

    expect(help?.fields).toEqual([
      "values.<key>  any JSON value  required — Map of field path to value.",
    ]);
    expect(completeExample(help)).toEqual({
      template_id: "xxxxx",
      values: { key: "value" },
    });
    expect(validateAgainstSchema(schema, completeExample(help)).valid).toBe(
      true,
    );
  });

  test("documents every branch of a discriminated upload body", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
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
      },
    };

    const help = buildInputContractHelp({ schema, inputOnly: ["body"] });
    const rendered = help?.fields.join("\n") ?? "";

    expect(rendered).toContain('variant 1, purpose = "entity_create"');
    expect(rendered).toContain("body.propertyId  string  required");
    expect(rendered).toContain('variant 2, purpose = "entity_version"');
    expect(rendered).toContain("body.entityId  string  required");
  });

  test("documents oneOf branches with a schema-valid example", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        value: {
          oneOf: [
            { type: "string", const: "first" },
            { type: "string", const: "second" },
          ],
        },
      },
      required: ["value"],
    };

    const help = buildInputContractHelp({
      schema,
      inputOnly: ["value"],
    });

    expect(help?.fields.join("\n")).toContain("one of 2 variants");
    expect(validateAgainstSchema(schema, completeExample(help)).valid).toBe(
      true,
    );
  });

  test("renders and satisfies simultaneous anyOf and oneOf constraints", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string", pattern: "^a" },
            { type: "string", pattern: "^b" },
          ],
          oneOf: [
            { type: "string", const: "apple" },
            { type: "string", const: "banana" },
          ],
        },
      },
      required: ["value"],
    };

    const help = buildInputContractHelp({
      schema,
      inputOnly: ["value"],
    });
    const fields = help?.fields.join("\n") ?? "";

    expect(fields).toContain("anyOf: one of 2 variants");
    expect(fields).toContain("oneOf: one of 2 variants");
    expect(validateAgainstSchema(schema, completeExample(help)).valid).toBe(
      true,
    );
  });

  test("bounds composed example search without materializing branch products", () => {
    const variants = Array.from({ length: 1000 }, (_, index) => ({
      type: "string",
      const: `value-${index}`,
    }));
    const schema: JsonSchema = {
      type: "object",
      properties: {
        value: {
          anyOf: variants,
          oneOf: variants,
        },
      },
      required: ["value"],
    };

    const help = buildInputContractHelp({
      schema,
      inputOnly: ["value"],
    });

    expect(validateAgainstSchema(schema, completeExample(help)).valid).toBe(
      true,
    );
  });

  test("marks capped composed examples unavailable instead of claiming completeness", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        value: {
          anyOf: [{ type: "string", const: "match" }],
          oneOf: [
            ...Array.from({ length: 64 }, (_, index) => ({
              type: "string",
              const: `other-${index}`,
            })),
            { type: "string", const: "match" },
          ],
        },
      },
      required: ["value"],
    };

    const help = buildInputContractHelp({ schema, inputOnly: ["value"] });

    expect(help?.example).toEqual({ status: "unavailable" });
  });

  test("renders required object fields declared only through allOf", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        tool: {
          type: "object",
          allOf: [
            {
              type: "object",
              properties: {
                prompt: { type: "string" },
                dependencies: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["prompt", "dependencies"],
            },
          ],
        },
      },
      required: ["tool"],
    };

    const help = buildInputContractHelp({ schema, inputOnly: ["tool"] });
    const fields = help?.fields.join("\n") ?? "";

    expect(fields).toContain("tool.prompt  string  required");
    expect(fields).toContain("tool.dependencies  array<string>  required");
  });

  test("merges requiredness across parent and sibling allOf branches", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        tool: {
          type: "object",
          required: ["prompt"],
          allOf: [
            {
              type: "object",
              properties: {
                prompt: { type: "string" },
                dependencies: { type: "array", items: { type: "string" } },
              },
            },
            { type: "object", required: ["dependencies"] },
          ],
        },
      },
    };

    const help = buildInputContractHelp({ schema, inputOnly: ["tool"] });
    const fields = help?.fields.join("\n") ?? "";

    expect(fields).toContain("tool.prompt  string  required");
    expect(fields).toContain("tool.dependencies  array<string>  required");
  });

  test("does not mislabel nested scalar allOf schemas as objects", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        value: {
          allOf: [{ allOf: [{ type: "string" }] }],
        },
      },
      required: ["value"],
    };

    const help = buildInputContractHelp({ schema, inputOnly: ["value"] });

    expect(help?.fields).toEqual(["value  string  required"]);
  });

  test("documents every branch of an array item union", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  type: { type: "string", const: "created" },
                  createdAt: { type: "string" },
                },
                required: ["type", "createdAt"],
              },
              {
                type: "object",
                properties: {
                  type: { type: "string", const: "deleted" },
                  reason: { type: "string" },
                },
                required: ["type", "reason"],
              },
            ],
          },
        },
      },
      required: ["events"],
    };

    const help = buildInputContractHelp({
      schema,
      inputOnly: ["events"],
    });
    const rendered = help?.fields.join("\n") ?? "";

    expect(rendered).toContain('variant 1, type = "created"');
    expect(rendered).toContain("events[].createdAt  string  required");
    expect(rendered).toContain('variant 2, type = "deleted"');
    expect(rendered).toContain("events[].reason  string  required");
  });

  test("derives nested requiredness from the field's immediate parent", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        body: {
          type: "object",
          properties: {
            requiredObject: { type: "object", additionalProperties: true },
            optionalObject: { type: "object", additionalProperties: true },
          },
          required: ["requiredObject"],
        },
      },
    };

    const help = buildInputContractHelp({
      schema,
      inputOnly: ["body.requiredObject", "body.optionalObject"],
    });

    expect(help?.fields.at(0)).toContain("required");
    expect(help?.fields.at(1)).toContain("optional");
  });

  test("documents pattern-property objects as maps", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        metadata: {
          type: "object",
          patternProperties: { "^(.*)$": { type: "string" } },
        },
      },
      required: ["metadata"],
    };

    const help = buildInputContractHelp({
      schema,
      inputOnly: ["metadata"],
    });

    expect(help?.fields).toEqual(["metadata.<key>  string  required"]);
    expect(completeExample(help)).toEqual({ metadata: { key: "xxxxx" } });
  });

  test("shell-quotes apostrophes in generated examples", () => {
    expect(formatInputExample({ value: "client's" })).toBe(
      `--input '{"value":"client'\\''s"}'`,
    );
  });

  test("synthesizes examples that satisfy anchored scalar patterns", () => {
    const patterns = [
      "^BOE-[A-Z]-\\d{4}-\\d+$",
      "^[0-9A-Fa-f]{6}$",
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      "^[A-Za-z0-9]{7}$",
      "^[A-Za-z]{2}$",
      "^\\d+$",
      "^\\d{8}$",
    ];

    for (const pattern of patterns) {
      const schema: JsonSchema = {
        type: "object",
        properties: { value: { type: "string", pattern } },
        required: ["value"],
      };
      const help = buildInputContractHelp({
        schema,
        inputOnly: ["value"],
      });

      expect(validateAgainstSchema(schema, completeExample(help)).valid).toBe(
        true,
      );
    }
  });

  test("does not advertise a complete example for an invalid schema pattern", () => {
    const help = buildInputContractHelp({
      schema: {
        type: "object",
        properties: { value: { type: "string", pattern: "[" } },
        required: ["value"],
      },
      inputOnly: ["value"],
    });

    expect(help?.example).toEqual({ status: "unavailable" });
  });
});

type GeneratedLeaf = Exclude<RouteNode, { kind: "route" }>;

const generatedLeaves = (node: RouteNode): GeneratedLeaf[] => {
  if (node.kind !== "route") {
    return [node];
  }
  return Object.values(node.children).flatMap(generatedLeaves);
};

describe("generated --input help invariants", () => {
  test("every input-only path is documented from its originating schema", () => {
    for (const node of generatedLeaves(generatedRouteMap)) {
      if (node.kind === "leaf") {
        const help = buildInputContractHelp({
          schema: node.spec.inputSchema,
          inputOnly: node.spec.inputOnly,
        });
        for (const path of node.spec.inputOnly) {
          expect(help?.fields.some((line) => line.includes(path))).toBe(true);
        }
        if (help !== undefined) {
          expect(
            validateAgainstSchema(node.spec.inputSchema, completeExample(help))
              .valid,
          ).toBe(true);
        }
        continue;
      }
      if (
        node.spec.inputSchema === undefined ||
        node.spec.inputOnly.length === 0
      ) {
        continue;
      }
      const help = buildInputContractHelp({
        schema: node.spec.inputSchema,
        inputOnly: node.spec.inputOnly,
      });
      for (const path of node.spec.inputOnly) {
        expect(help?.fields.some((line) => line.includes(path))).toBe(true);
      }
      const validation = validateAgainstSchema(
        node.spec.inputSchema,
        completeExample(help),
      );
      if (!validation.valid) {
        throw new Error(
          `${node.spec.capabilityId} generated invalid example at ${validation.path}: ${validation.message}`,
        );
      }
    }
  });
});
