import { toJsonSchema } from "@valibot/to-json-schema";
import { panic } from "better-result";
import * as v from "valibot";

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
  return properties === undefined
    ? { ...objectSchema, type: "object" }
    : { ...objectSchema, properties, type: "object" };
};

/**
 * Defines a native tool from the same Valibot schema its handler parses.
 * `inputSchemaSource` retains that actual schema as internal registry metadata:
 * handlers parse through the definition, while wire projection selects only
 * MCP protocol fields. The static compile-time ratchet also uses its presence
 * to distinguish derived schemas from legacy hand-maintained mirrors.
 */
export const defineValibotMcpTool = <
  const TSchema extends v.GenericSchema,
  const TName extends string,
  const TDefinition extends Omit<McpToolDefinition, "inputSchema" | "name">,
>({
  inputSchema,
  jsonSchemaProjectionWaiver,
  name,
  ...definition
}: TDefinition & {
  inputSchema: TSchema;
  jsonSchemaProjectionWaiver?: JsonSchemaProjectionWaiver;
  name: TName;
}) => ({
  ...definition,
  inputSchema: deriveMcpInputSchema(inputSchema, jsonSchemaProjectionWaiver),
  inputSchemaSource: inputSchema,
  name,
});
