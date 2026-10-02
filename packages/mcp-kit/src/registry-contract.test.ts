import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { jsonSuccess } from "./envelope";
import { readToolInput } from "./input";
import { compactSchema, hoistRepeatedSchemas } from "./schema";
import { createToolSurface } from "./surface";
import type { ToolDefinition } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined || typeof value === "string") {
    return value;
  }
  throw new Error("Expected optional registry text");
};

const registryTool = (value: unknown) => {
  if (!isRecord(value)) {
    throw new Error("Expected registry metadata");
  }
  const {
    name,
    summary,
    access,
    destructive,
    inputSchema,
    direct,
    exactProperties,
    exampleInput,
  } = value;
  if (
    typeof name !== "string" ||
    typeof summary !== "string" ||
    (access !== "read" && access !== "write") ||
    typeof destructive !== "boolean" ||
    !isRecord(inputSchema)
  ) {
    throw new Error("Invalid registry tool metadata");
  }
  if (
    direct !== undefined &&
    (!isRecord(direct) || !isRecord(direct["inputSchema"]))
  ) {
    throw new Error("Invalid direct registry schema");
  }
  if (
    !Array.isArray(exactProperties) ||
    !exactProperties.every((entry: unknown) => typeof entry === "string")
  ) {
    throw new Error("Invalid exact registry properties");
  }
  if (exampleInput !== undefined && !isRecord(exampleInput)) {
    throw new Error("Invalid registry example input");
  }
  const guide = optionalString(value["guide"]);
  const brief = optionalString(value["brief"]);
  const domain = optionalString(value["domain"]);
  return {
    name,
    summary,
    access,
    destructive,
    inputSchema,
    ...(guide !== undefined && { guide }),
    ...(brief !== undefined && { brief }),
    ...(domain !== undefined && { domain }),
    ...(exampleInput !== undefined && { exampleInput }),
    describedSchema: hoistRepeatedSchemas(
      compactSchema(inputSchema, {
        describedDepth: 1,
        omitMaxSafeInteger: true,
        schemaDialect: "omit",
      }),
      { definitionNames: "property" },
    ),
    ...(direct !== undefined && {
      direct: { inputSchema: direct["inputSchema"] },
    }),
    exactProperties,
    run: async (args: Record<string, unknown>) =>
      jsonSuccess({ tool: name, args }),
  } satisfies ToolDefinition<undefined>;
};

test("downstream configuration preserves all real registry discovery and invocation wire bytes", async () => {
  // Frozen metadata and old-kit wire strings; capture provenance lives in the fixture.
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL("fixtures/folio-registry.json", import.meta.url),
      "utf-8",
    ),
  );
  if (
    !isRecord(fixture) ||
    !Array.isArray(fixture["tools"]) ||
    !Array.isArray(fixture["cases"]) ||
    typeof fixture["listing"] !== "string"
  ) {
    throw new Error("Invalid frozen registry contract");
  }
  const tools = fixture["tools"].map(registryTool);
  expect(tools).toHaveLength(14);
  expect(new Set(tools.map(({ name }) => name)).size).toBe(tools.length);
  const surface = createToolSurface({
    tools,
    discovery: { type: "outline" },
    fullSchema: "described",
    capabilityResult: "payload",
    validationResult: "input",
    capabilityList: "minimal",
    metaDescriptions: "enumerated",
  });
  expect(JSON.stringify(surface.listTools())).toBe(fixture["listing"]);
  expect(fixture["cases"]).toHaveLength(38);
  const compactDescriptions = new Set<string>();
  const fullDescriptions = new Set<string>();
  for (const entry of fixture["cases"]) {
    if (
      !isRecord(entry) ||
      typeof entry["name"] !== "string" ||
      !isRecord(entry["args"]) ||
      typeof entry["result"] !== "string"
    ) {
      throw new Error("Invalid frozen registry call");
    }
    if (entry["name"] === "describe_capability") {
      const capability = entry["args"]["capability"];
      if (typeof capability !== "string") {
        throw new TypeError("Expected a described registry capability");
      }
      (entry["args"]["detail"] === "full"
        ? fullDescriptions
        : compactDescriptions
      ).add(capability);
    }
    expect(
      JSON.stringify(
        await surface.callTool(entry["name"], entry["args"], undefined),
      ),
    ).toBe(entry["result"]);
  }
  const names = tools.map(({ name }) => name).toSorted();
  expect([...compactDescriptions].toSorted()).toEqual(names);
  expect([...fullDescriptions].toSorted()).toEqual(names);
});

test("compact schemas preserve prototype-named nested properties and instance keys", () => {
  const schema: unknown = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"integer","maximum":9007199254740991},"constructor":{"type":"object","properties":{"toString":{"type":"string","description":"label"}}},"literal":{"const":{"__proto__":{"maximum":9007199254740991,"$schema":"instance"}}}}}',
  );
  if (!isRecord(schema)) {
    throw new Error("Expected prototype-key schema fixture");
  }
  const expected: unknown = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"integer"},"constructor":{"type":"object","properties":{"toString":{"type":"string"}}},"literal":{"const":{"__proto__":{"maximum":9007199254740991,"$schema":"instance"}}}}}',
  );
  expect(
    compactSchema(schema, { omitMaxSafeInteger: true, schemaDialect: "omit" }),
  ).toEqual(expected);
  expect(Object.prototype).not.toHaveProperty("maximum");
});

test.each(["__proto__", "constructor", "toString"])(
  "normalization preserves nested JSON property %s",
  (key) => {
    const entry = { retained: true };
    const value = { payload: Object.fromEntries([[key, entry]]) };
    const read = readToolInput({
      schema: {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: Object.fromEntries([[key, { type: "object" }]]),
          },
        },
      },
      value,
      access: "read",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error(read.message);
    }
    expect(JSON.stringify(read.value)).toBe(JSON.stringify(value));
    const payload = read.value["payload"];
    if (!isRecord(payload)) {
      throw new Error("Expected normalized nested object");
    }
    expect(Object.hasOwn(payload, key)).toBe(true);
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(payload[key]).toEqual(entry);
  },
);
