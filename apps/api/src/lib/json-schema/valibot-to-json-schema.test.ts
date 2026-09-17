import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { AGENT_INPUT_NORMALIZATION_KEY } from "@stll/agent-input";
import { propertyConfig } from "@stll/property-testing";

import { ANALYSIS_OUTPUT_JSON_SCHEMA } from "@/api/handlers/case-law/analysis/analysis-output";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
  LAW_MCP_TOOL_DEFINITIONS,
} from "@/api/mcp/static-tool-definitions";

// Every keyword JSON Schema (draft-07, 2020-12) and the OpenAPI 3.0 subset
// define, plus the vendor extensions Stella advertises on purpose. A key
// outside this set on an emitted node is a leak: internal metadata today,
// whatever a converter release starts copying tomorrow.
const JSON_SCHEMA_KEYWORDS = new Set([
  AGENT_INPUT_NORMALIZATION_KEY,
  "$schema",
  "$id",
  "$ref",
  "$comment",
  "$defs",
  "definitions",
  "title",
  "description",
  "examples",
  "default",
  "readOnly",
  "writeOnly",
  "deprecated",
  "nullable",
  "type",
  "enum",
  "const",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "items",
  "prefixItems",
  "additionalItems",
  "contains",
  "minItems",
  "maxItems",
  "uniqueItems",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "required",
  "minProperties",
  "maxProperties",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "contentEncoding",
  "contentMediaType",
]);

/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
  "dependencies",
]);

/** Keywords whose value is a subschema or a list of subschemas. */
const SUBSCHEMA_KEYWORDS = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "contains",
  "additionalProperties",
  "propertyNames",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON Pointer-ish paths of every non-keyword key in a schema tree. */
const findNonKeywordKeys = (schema: unknown, path = "#"): string[] => {
  if (!isRecord(schema)) {
    return [];
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const at = `${path}/${key}`;
    if (!JSON_SCHEMA_KEYWORDS.has(key)) {
      found.push(at);
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      for (const [name, subschema] of Object.entries(value)) {
        found.push(...findNonKeywordKeys(subschema, `${at}/${name}`));
      }
    } else if (SUBSCHEMA_KEYWORDS.has(key)) {
      const subschemas = Array.isArray(value) ? value : [value];
      for (const [index, subschema] of subschemas.entries()) {
        const subPath = Array.isArray(value) ? `${at}/${index}` : at;
        found.push(...findNonKeywordKeys(subschema, subPath));
      }
    }
  }
  return found;
};

const metadataArbitrary = fc.option(
  fc.record(
    {
      title: fc.string(),
      description: fc.string(),
      examples: fc.array(fc.string(), { maxLength: 2 }),
      internal: fc.dictionary(
        fc
          .stringMatching(/^[A-Za-z_][\w-]{0,15}$/u)
          .filter((key) => !JSON_SCHEMA_KEYWORDS.has(key)),
        fc.jsonValue(),
        { minKeys: 1, maxKeys: 3 },
      ),
    },
    { requiredKeys: ["internal"] },
  ),
  { nil: undefined },
);

type Metadata = {
  title?: string;
  description?: string;
  examples?: string[];
  internal: Record<string, fc.JsonValue>;
};

const annotate = (
  schema: v.GenericSchema,
  metadata: Metadata | undefined,
): v.GenericSchema => {
  if (metadata === undefined) {
    return schema;
  }
  const { internal, ...annotations } = metadata;
  return v.pipe(schema, v.metadata({ ...internal, ...annotations }));
};

const leafArbitrary = fc.constantFrom(
  () => v.string(),
  () => v.number(),
  () => v.boolean(),
  () => v.picklist(["a", "b"]),
);

const { schema: schemaArbitrary } = fc.letrec<{ schema: v.GenericSchema }>(
  (tie) => ({
    schema: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      fc
        .tuple(leafArbitrary, metadataArbitrary)
        .map(([make, metadata]) => annotate(make(), metadata)),
      fc
        .tuple(
          fc.array(tie("schema"), { minLength: 1, maxLength: 3 }),
          metadataArbitrary,
        )
        .map(([fields, metadata]) =>
          annotate(
            v.object(
              Object.fromEntries(
                fields.map((field, index) => [`field${index}`, field]),
              ),
            ),
            metadata,
          ),
        ),
      fc
        .tuple(tie("schema"), metadataArbitrary)
        .map(([item, metadata]) => annotate(v.array(item), metadata)),
      fc
        .tuple(
          fc.array(tie("schema"), { minLength: 2, maxLength: 3 }),
          metadataArbitrary,
        )
        .map(([options, metadata]) => annotate(v.union(options), metadata)),
      fc
        .tuple(tie("schema"), metadataArbitrary)
        .map(([inner, metadata]) => annotate(v.nullable(inner), metadata)),
      fc
        .tuple(tie("schema"), metadataArbitrary)
        .map(([value, metadata]) =>
          annotate(v.record(v.string(), value), metadata),
        ),
    ),
  }),
);

describe("toJsonSchema", () => {
  test("emits only JSON Schema keywords, whatever metadata a schema carries", () => {
    fc.assert(
      fc.property(schemaArbitrary, (schema) => {
        expect(findNonKeywordKeys(toJsonSchema(schema))).toEqual([]);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("keeps the JSON Schema annotations metadata carries", () => {
    fc.assert(
      fc.property(leafArbitrary, metadataArbitrary, (make, metadata) => {
        const emitted = toJsonSchema(annotate(make(), metadata));
        expect(emitted.title).toEqual(metadata?.title);
        expect(emitted.description).toEqual(metadata?.description);
        expect(emitted.examples).toEqual(metadata?.examples);
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });
});

describe("emitted production schemas", () => {
  const surfaces = [
    ["MCP default", DEFAULT_MCP_TOOL_DEFINITIONS],
    ["MCP anonymized", ANONYMIZED_MCP_TOOL_DEFINITIONS],
    ["MCP law", LAW_MCP_TOOL_DEFINITIONS],
  ] as const;

  test.each(surfaces)(
    "%s tool schemas carry only JSON Schema keywords",
    (_, definitions) => {
      const leaks: string[] = [];
      for (const tool of toMcpTools(definitions)) {
        leaks.push(
          ...findNonKeywordKeys(tool.inputSchema, `${tool.name}/input`),
          ...findNonKeywordKeys(tool.outputSchema, `${tool.name}/output`),
        );
      }
      expect(leaks).toEqual([]);
    },
  );

  test("the case-law analysis output schema carries only JSON Schema keywords", () => {
    expect(findNonKeywordKeys(ANALYSIS_OUTPUT_JSON_SCHEMA)).toEqual([]);
  });
});
