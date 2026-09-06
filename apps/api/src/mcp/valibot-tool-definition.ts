import { toJsonSchema } from "@valibot/to-json-schema";
import { panic } from "better-result";
import type * as v from "valibot";

import type {
  McpToolDefinition,
  McpToolInputSchema,
} from "@/api/mcp/tool-types";
import type { NullAsAbsentInputSchema } from "@/api/mcp/tool-utils";

const VALIBOT_MCP_JSON_SCHEMA_CONFIG = {
  errorMode: "throw",
  target: "draft-07",
  typeMode: "input",
} as const;

type ToJsonSchemaConfig = NonNullable<Parameters<typeof toJsonSchema>[1]>;

type JsonSchemaProjectionWaiver = {
  ignoreActions: NonNullable<ToJsonSchemaConfig["ignoreActions"]>;
  reason: string;
};

type ValibotMcpToolInput = Omit<McpToolDefinition, "inputSchema"> & {
  inputSchema: NullAsAbsentInputSchema;
  jsonSchemaProjectionWaiver?: JsonSchemaProjectionWaiver;
};

type ValibotMcpToolDefinition<TDefinition extends ValibotMcpToolInput> = Omit<
  TDefinition,
  "inputSchema" | "jsonSchemaProjectionWaiver"
> & {
  inputSchema: McpToolInputSchema;
  inputSchemaSource: TDefinition["inputSchema"];
};

const deriveMcpInputSchema = (
  schema: v.GenericSchema,
  projectionWaiver: JsonSchemaProjectionWaiver | undefined,
): McpToolInputSchema => {
  const { $schema: _dialect, ...jsonSchema } = toJsonSchema(
    schema,
    projectionWaiver === undefined
      ? VALIBOT_MCP_JSON_SCHEMA_CONFIG
      : {
          ...VALIBOT_MCP_JSON_SCHEMA_CONFIG,
          ignoreActions: projectionWaiver.ignoreActions,
        },
  );
  if (jsonSchema.type !== "object") {
    return panic("A native MCP tool input schema must accept an object root");
  }
  if (jsonSchema.additionalProperties !== false) {
    return panic(
      "A native MCP tool input schema must reject unknown root properties",
    );
  }

  const { properties, ...objectSchema } = jsonSchema;
  const cleaned = projectSchemaKeywords(objectSchema);
  return properties === undefined
    ? { ...cleaned, type: "object" }
    : {
        ...cleaned,
        properties: projectSchemaKeywordsInMap(properties),
        type: "object",
      };
};

const isSchemaRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Keywords whose value maps names to schemas rather than being a schema. The
 * map is walked by value so a property that happens to be named
 * `propertyNames` is never mistaken for the keyword.
 */
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "patternProperties",
  "properties",
]);

/**
 * Two keyword rewrites the wire schema needs that the Valibot export does not
 * make on its own:
 *
 * - `v.record(v.string(), ...)` projects `propertyNames: { type: "string" }`,
 *   which every JSON object satisfies. The keyword says nothing to a caller
 *   and sits on the CLI trust boundary's deny list, so it is dropped wherever
 *   it is trivial; a non-trivial `propertyNames` (a pattern, an enum) is kept.
 * - `v.variant` projects `oneOf` and `v.literal` projects `const`. Neither
 *   keyword is in the provider-safe dialect the chat tool surface serializes
 *   these same definitions into. Variant branches are discriminated, hence
 *   mutually exclusive, so `anyOf` accepts exactly the same values; a
 *   one-value `enum` is the literal.
 */
const projectSchemaKeywords = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const { oneOf, propertyNames, ...rest } = schema;
  const keep =
    isSchemaRecord(propertyNames) &&
    !(
      Object.keys(propertyNames).length === 1 &&
      propertyNames["type"] === "string"
    );
  if (oneOf !== undefined && rest["anyOf"] !== undefined) {
    return panic("A schema node carries both oneOf and anyOf; cannot fold");
  }
  if ("const" in rest && rest["enum"] !== undefined) {
    return panic("A schema node carries both const and enum; cannot fold");
  }
  const entries = Object.entries(rest).map(
    ([key, value]): [string, unknown] => {
      if (key === "const") {
        return ["enum", [value]];
      }
      return [
        key,
        SCHEMA_MAP_KEYWORDS.has(key) && isSchemaRecord(value)
          ? projectSchemaKeywordsInMap(value)
          : projectSchemaKeywordsIn(value),
      ];
    },
  );
  if (oneOf !== undefined) {
    entries.push(["anyOf", projectSchemaKeywordsIn(oneOf)]);
  }
  if ("const" in rest && rest["type"] === undefined) {
    const literalType = jsonLiteralType(rest["const"]);
    if (literalType !== undefined) {
      entries.push(["type", literalType]);
    }
  }
  const cleaned = Object.fromEntries(entries);
  return keep ? { ...cleaned, propertyNames } : cleaned;
};

const jsonLiteralType = (value: unknown): string | undefined => {
  if (value === null) {
    return "null";
  }
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean"
    ? type
    : undefined;
};

const projectSchemaKeywordsInMap = (
  map: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(map).map(([key, value]): [string, unknown] => [
      key,
      projectSchemaKeywordsIn(value),
    ]),
  );

const projectSchemaKeywordsIn = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(projectSchemaKeywordsIn);
  }
  return isSchemaRecord(value) ? projectSchemaKeywords(value) : value;
};

/**
 * Defines a native tool from the same Valibot schema its handler parses.
 * `inputSchemaSource` retains that actual schema as internal registry metadata:
 * handlers parse through the definition, while wire projection selects only
 * MCP protocol fields. The static compile-time ratchet also uses its presence
 * to distinguish derived schemas from legacy hand-maintained mirrors.
 *
 * `inputSchema` must be wrapped in `nullAsAbsent`, so that a strict
 * tool-schema client's `null` for an unset optional property reads as
 * absence for every consumer of the schema rather than in one handler. The
 * wrapper is input-side only: projection reads the declared object it wraps,
 * so the advertised schema is exactly what the object declares.
 */
export const defineValibotMcpTool = <
  const TDefinition extends ValibotMcpToolInput,
>(
  definition: TDefinition,
): ValibotMcpToolDefinition<TDefinition> => {
  const { inputSchema, jsonSchemaProjectionWaiver, ...toolDefinition } =
    definition;
  return {
    ...toolDefinition,
    inputSchema: deriveMcpInputSchema(
      inputSchema.advertisedSchema,
      jsonSchemaProjectionWaiver,
    ),
    inputSchemaSource: inputSchema,
  };
};
