import { expect, test } from "bun:test";

import registry from "./generated/registry-snapshot.json";
import { generatedRouteMap } from "./generated/route-map.js";
import type { generatedToolAnnotations } from "./generated/tool-annotations.js";
import { validateAgainstSchema } from "./json-schema-validate.js";
import type { JsonSchema, RouteNode } from "./route-types.js";

const listToolNames = (node: RouteNode): string[] => {
  switch (node.kind) {
    case "route":
      return Object.values(node.children).flatMap(listToolNames);
    case "leaf":
      return node.spec.toolName.startsWith("list_") ? [node.spec.toolName] : [];
    case "capability-leaf":
      return [];
    default:
      node satisfies never;
      throw new TypeError("Unknown command node");
  }
};

// An exclusion must name a generated tool and explain why a finite collection
// cannot expose a continuation cursor.
const unpageableTools: ReadonlyMap<
  keyof typeof generatedToolAnnotations,
  { reason: string }
> = new Map();

const schemaObject = (value: unknown): JsonSchema => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an object schema");
  }
  return Object.fromEntries(Object.entries(value));
};

const carriesNextCursor = (schema: unknown): boolean => {
  if (typeof schema !== "object" || schema === null) {
    return false;
  }
  if (
    "properties" in schema &&
    typeof schema.properties === "object" &&
    schema.properties !== null &&
    "nextCursor" in schema.properties
  ) {
    return true;
  }
  return ["anyOf", "oneOf", "allOf"].some((keyword) => {
    if (!(keyword in schema)) {
      return false;
    }
    const branches = Reflect.get(schema, keyword);
    return Array.isArray(branches) && branches.some(carriesNextCursor);
  });
};

test("every generated list command exposes the server paging contract", () => {
  const names = new Set(listToolNames(generatedRouteMap));
  expect(names.size).toBeGreaterThan(0);
  for (const [name, { reason }] of unpageableTools) {
    expect(names.has(name)).toBe(true);
    expect(reason.trim().length).toBeGreaterThan(0);
  }
  const matters = registry.find((tool) => tool.name === "list_matters");
  expect(matters).toBeDefined();
  if (matters === undefined) {
    throw new TypeError("Missing list_matters");
  }
  const matterLimit = schemaObject(matters.inputSchema.properties["limit"]);
  for (const name of names) {
    const tool = registry.find((entry) => entry.name === name);
    expect(tool, name).toBeDefined();
    if (tool === undefined) {
      throw new TypeError(`Missing ${name}`);
    }
    if ([...unpageableTools.keys()].some((excluded) => excluded === name)) {
      continue;
    }
    const properties = schemaObject(tool.inputSchema.properties);
    const limit = schemaObject(properties["limit"]);
    const cursor = schemaObject(properties["cursor"]);
    expect(limit, name).toMatchObject({
      type: "integer",
      minimum: matterLimit["minimum"],
      maximum: matterLimit["maximum"],
    });
    expect(cursor, name).toMatchObject({ type: "string" });
    expect(validateAgainstSchema(limit, 1).valid, name).toBe(true);
    expect(
      validateAgainstSchema(limit, matterLimit["maximum"]).valid,
      name,
    ).toBe(true);
    expect(validateAgainstSchema(cursor, "eyJpZCI6IjEifQ").valid, name).toBe(
      true,
    );
    expect(carriesNextCursor(schemaObject(tool)["outputSchema"]), name).toBe(
      true,
    );
  }
});
