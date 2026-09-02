import { toJsonSchema } from "@valibot/to-json-schema";
import { panic } from "better-result";
import type * as v from "valibot";

import type {
  McpToolDefinition,
  McpToolInputSchema,
} from "@/api/mcp/tool-types";

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
  inputSchema: v.GenericSchema;
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
  const projected =
    properties === undefined
      ? { ...objectSchema, type: "object" as const }
      : { ...objectSchema, properties, type: "object" as const };
  return withoutTrivialPropertyNames(projected);
};

const isSchemaRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `v.record(v.string(), ...)` projects `propertyNames: { type: "string" }`,
 * which every JSON object satisfies. The keyword says nothing to a caller and
 * sits on the CLI trust boundary's deny list, so it is dropped wherever it is
 * trivial; a non-trivial `propertyNames` (a pattern, an enum) is kept as-is.
 */
const withoutTrivialPropertyNames = <T>(schema: T): T => {
  if (Array.isArray(schema)) {
    return schema.map(withoutTrivialPropertyNames) as T;
  }
  if (!isSchemaRecord(schema)) {
    return schema;
  }
  const { propertyNames, ...rest } = schema;
  const keep =
    isSchemaRecord(propertyNames) &&
    !(
      Object.keys(propertyNames).length === 1 &&
      propertyNames["type"] === "string"
    );
  const entries = Object.entries(rest).map(([key, value]) => [
    key,
    withoutTrivialPropertyNames(value),
  ]);
  const cleaned = Object.fromEntries(entries);
  return (keep ? { ...cleaned, propertyNames } : cleaned) as T;
};

/**
 * Defines a native tool from the same Valibot schema its handler parses.
 * `inputSchemaSource` retains that actual schema as internal registry metadata:
 * handlers parse through the definition, while wire projection selects only
 * MCP protocol fields. The static compile-time ratchet also uses its presence
 * to distinguish derived schemas from legacy hand-maintained mirrors.
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
    inputSchema: deriveMcpInputSchema(inputSchema, jsonSchemaProjectionWaiver),
    inputSchemaSource: inputSchema,
  };
};
