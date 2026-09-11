import { toJsonSchema } from "@valibot/to-json-schema";
import { panic } from "better-result";
import type * as v from "valibot";

import {
  agentInputNormalizationMetadata,
  type AgentInputNormalizationAnnotation,
} from "@stll/agent-input";

import type {
  McpToolDefinition,
  McpToolInputSchema,
  McpToolOutputContract,
  McpToolOutputSchema,
} from "@/api/mcp/tool-types";
import type { NullAsAbsentInputSchema } from "@/api/mcp/tool-utils";

const VALIBOT_MCP_JSON_SCHEMA_CONFIG = {
  errorMode: "throw",
  target: "draft-07",
  typeMode: "input",
} as const;

const CHAT_STRING_ID_CUSTOM_SCHEMA_MESSAGES = new Set([
  "Expected a matter identifier",
  "Expected a contact identifier",
  "Expected a property identifier",
  "Expected an entity identifier",
]);

type ToJsonSchemaConfig = NonNullable<Parameters<typeof toJsonSchema>[1]>;

type JsonSchemaProjectionWaiver = {
  ignoreActions: NonNullable<ToJsonSchemaConfig["ignoreActions"]>;
  reason: string;
};

type ValibotMcpToolInput = Omit<McpToolDefinition, "inputSchema"> & {
  inputSchema: NullAsAbsentInputSchema;
  /** Explicit kinds JSON Schema cannot express, keyed by dotted field path. */
  inputNormalization?: Readonly<
    Record<string, AgentInputNormalizationAnnotation>
  >;
  jsonSchemaProjectionWaiver?: JsonSchemaProjectionWaiver;
};

type ValibotMcpToolDefinition<TDefinition extends ValibotMcpToolInput> = Omit<
  TDefinition,
  "inputSchema" | "inputNormalization" | "jsonSchemaProjectionWaiver"
> & {
  inputSchema: McpToolInputSchema;
  inputSchemaSource: TDefinition["inputSchema"];
};

const appendGuidance = (
  schema: Record<string, unknown>,
  annotation: AgentInputNormalizationAnnotation,
): void => {
  const description = schema["description"];
  Object.assign(
    schema,
    agentInputNormalizationMetadata(
      annotation,
      typeof description === "string" ? description : undefined,
    ),
  );
};

const annotateSchemaPath = ({
  schema,
  path,
  annotation,
}: {
  schema: Record<string, unknown>;
  path: readonly string[];
  annotation: AgentInputNormalizationAnnotation;
}): boolean => {
  const segment = path.at(0);
  if (segment === undefined) {
    appendGuidance(schema, annotation);
    return true;
  }
  let found = false;
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      if (isSchemaRecord(branch)) {
        found =
          annotateSchemaPath({ schema: branch, path, annotation }) || found;
      }
    }
  }
  const arraySegment = segment.endsWith("[]");
  const propertyName = arraySegment ? segment.slice(0, -2) : segment;
  const properties = schema["properties"];
  const property = isSchemaRecord(properties) ? properties[propertyName] : null;
  if (!isSchemaRecord(property)) {
    return found;
  }
  const target = arraySegment ? property["items"] : property;
  return isSchemaRecord(target)
    ? annotateSchemaPath({
        schema: target,
        path: path.slice(1),
        annotation,
      }) || found
    : found;
};

const applyInputNormalizationPlan = (
  schema: McpToolInputSchema,
  plan: Readonly<Record<string, AgentInputNormalizationAnnotation>> | undefined,
): McpToolInputSchema => {
  if (plan === undefined) {
    return schema;
  }
  for (const [path, annotation] of Object.entries(plan)) {
    if (
      !annotateSchemaPath({
        schema,
        path: path.split("."),
        annotation,
      })
    ) {
      return panic(`Agent input normalization path does not exist: ${path}`);
    }
  }
  return schema;
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

const deriveMcpOutputSchema = (
  schema: v.GenericSchema,
  customSchemaProjection: "none" | "chat-string-ids" = "none",
): McpToolOutputSchema => {
  const { $schema: _dialect, ...jsonSchema } = toJsonSchema(
    schema,
    customSchemaProjection === "none"
      ? VALIBOT_MCP_JSON_SCHEMA_CONFIG
      : {
          ...VALIBOT_MCP_JSON_SCHEMA_CONFIG,
          overrideSchema: ({ valibotSchema }) => {
            if (valibotSchema.type !== "custom") {
              return undefined;
            }
            const message =
              "message" in valibotSchema ? valibotSchema.message : undefined;
            return typeof message === "string" &&
              CHAT_STRING_ID_CUSTOM_SCHEMA_MESSAGES.has(message)
              ? { type: "string" }
              : undefined;
          },
        },
  );
  const projected = compactMcpOutputSchema(
    simplifyMcpOutputSchema(projectSchemaKeywords(jsonSchema)),
  );
  const acceptsObject =
    projected["type"] === "object" ||
    ["anyOf", "allOf"].some((keyword) => {
      const branches = projected[keyword];
      return (
        Array.isArray(branches) &&
        branches.length > 0 &&
        branches.every(
          (branch) => isSchemaRecord(branch) && branch["type"] === "object",
        )
      );
    });
  if (!acceptsObject) {
    return panic("A native MCP tool output schema must accept an object root");
  }
  return projected;
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

const schemaKey = (schema: Record<string, unknown>): string =>
  JSON.stringify(schema);

const uniqueSchemas = (
  schemas: readonly Record<string, unknown>[],
): Record<string, unknown>[] => {
  const seen = new Set<string>();
  return schemas.filter((schema) => {
    const key = schemaKey(schema);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const combineSchemas = (
  schemas: readonly Record<string, unknown>[],
): Record<string, unknown> => {
  const unique = uniqueSchemas(schemas);
  return unique.length === 1 ? (unique.at(0) ?? {}) : { anyOf: unique };
};

const MERGEABLE_OBJECT_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "properties",
  "required",
  "type",
]);

/**
 * Safely widens a union of closed object outputs into one compact object. It
 * never drops a possible property or narrows a value schema: properties seen
 * in only some branches become optional, while differing property schemas stay
 * as `anyOf`. The executable Valibot source remains exact at dispatch.
 */
const mergeObjectUnion = (
  branches: readonly unknown[],
): Record<string, unknown> | undefined => {
  if (
    branches.length === 0 ||
    !branches.every(
      (branch) =>
        isSchemaRecord(branch) &&
        branch["type"] === "object" &&
        Object.keys(branch).every((key) =>
          MERGEABLE_OBJECT_SCHEMA_KEYS.has(key),
        ) &&
        (branch["properties"] === undefined ||
          isSchemaRecord(branch["properties"])),
    )
  ) {
    return undefined;
  }

  const objectBranches = branches.filter(isSchemaRecord);
  const propertyNames = new Set<string>();
  for (const branch of objectBranches) {
    const properties = branch["properties"];
    if (isSchemaRecord(properties)) {
      for (const name of Object.keys(properties)) {
        propertyNames.add(name);
      }
    }
  }

  const properties: Record<string, unknown> = {};
  for (const name of propertyNames) {
    const schemas = objectBranches.flatMap((branch) => {
      const branchProperties = branch["properties"];
      const property = isSchemaRecord(branchProperties)
        ? branchProperties[name]
        : undefined;
      return isSchemaRecord(property) ? [property] : [];
    });
    properties[name] = combineSchemas(schemas);
  }

  const required = [...propertyNames].filter((name) =>
    objectBranches.every(
      (branch) =>
        Array.isArray(branch["required"]) && branch["required"].includes(name),
    ),
  );

  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    ...(objectBranches.every(
      (branch) => branch["additionalProperties"] === false,
    )
      ? { additionalProperties: false }
      : {}),
  };
};

/**
 * Provider-facing output schemas favor a compact safe superset. This recursive
 * pass only deduplicates alternatives and merges object unions with the
 * widening rule above; it never guesses which domain fields are unimportant.
 */
const simplifyMcpOutputSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const simplified: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isSchemaRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, nested] of Object.entries(value)) {
        mapped[name] = isSchemaRecord(nested)
          ? simplifyMcpOutputSchema(nested)
          : nested;
      }
      simplified[key] = mapped;
      continue;
    }
    if (Array.isArray(value)) {
      simplified[key] = value.map((nested: unknown) =>
        isSchemaRecord(nested) ? simplifyMcpOutputSchema(nested) : nested,
      );
      continue;
    }
    simplified[key] = isSchemaRecord(value)
      ? simplifyMcpOutputSchema(value)
      : value;
  }

  const alternatives = simplified["anyOf"];
  if (!Array.isArray(alternatives) || !alternatives.every(isSchemaRecord)) {
    return simplified;
  }
  const unique = uniqueSchemas(alternatives);
  if (unique.length !== alternatives.length) {
    simplified["anyOf"] = unique;
  }
  const merged = mergeObjectUnion(unique);
  if (merged === undefined) {
    return simplified;
  }
  const { anyOf: _alternatives, ...siblings } = simplified;
  return { ...siblings, ...merged };
};

const MCP_OUTPUT_SCHEMA_MAX_DETAIL_DEPTH = 3;

/**
 * Keep root fields and list-item fields visible to models, then widen deeper
 * object internals. This bounds registry cost without hand-selecting domain
 * fields: the exact source schema still validates every nested value at
 * dispatch, and the published schema remains a truthful superset.
 */
const compactMcpOutputSchema = (
  schema: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> => {
  if (
    depth >= MCP_OUTPUT_SCHEMA_MAX_DETAIL_DEPTH &&
    schema["type"] === "object"
  ) {
    return { type: "object", additionalProperties: true };
  }

  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isSchemaRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, nested] of Object.entries(value)) {
        mapped[name] = isSchemaRecord(nested)
          ? compactMcpOutputSchema(nested, depth + 1)
          : nested;
      }
      compacted[key] = mapped;
      continue;
    }
    if (Array.isArray(value)) {
      compacted[key] = value.map((nested: unknown) =>
        isSchemaRecord(nested)
          ? compactMcpOutputSchema(nested, depth + 1)
          : nested,
      );
      continue;
    }
    compacted[key] = isSchemaRecord(value)
      ? compactMcpOutputSchema(value, depth + 1)
      : value;
  }
  return compacted;
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
  const {
    inputNormalization,
    inputSchema,
    jsonSchemaProjectionWaiver,
    ...toolDefinition
  } = definition;
  return {
    ...toolDefinition,
    inputSchema: applyInputNormalizationPlan(
      deriveMcpInputSchema(
        inputSchema.advertisedSchema,
        jsonSchemaProjectionWaiver,
      ),
      inputNormalization,
    ),
    inputSchemaSource: inputSchema,
  };
};

/**
 * Defines the one output contract used for handler typing, tools/list, and
 * post-egress validation. Keeping the Valibot source in the returned value is
 * deliberate: publishing only its JSON Schema projection would lose the
 * executable contract and permit runtime drift.
 */
export const defineMcpToolOutput = <const TSchema extends v.GenericSchema>(
  outputSchemaSource: TSchema,
): McpToolOutputContract<v.InferInput<TSchema>, TSchema, "identity"> => ({
  outputSchema: deriveMcpOutputSchema(outputSchemaSource),
  outputSchemaSource,
  project: (data) => data,
  projection: "identity",
});

/**
 * Chat projection schemas brand tenant ids with `v.custom` validators. Their
 * closed annotation vocabulary guarantees those custom nodes are strings; the
 * wire schema can therefore publish `type: string` while the original custom
 * validator remains authoritative at runtime. No other unsupported schema is
 * ignored or guessed.
 */
export const defineChatProjectionMcpToolOutput = <
  const TSchema extends v.GenericSchema,
>(
  outputSchemaSource: TSchema,
): McpToolOutputContract<v.InferInput<TSchema>, TSchema, "identity"> => ({
  outputSchema: deriveMcpOutputSchema(outputSchemaSource, "chat-string-ids"),
  outputSchemaSource,
  project: (data) => data,
  projection: "identity",
});

export const defineProjectedMcpToolOutput = <
  const TSchema extends v.GenericSchema,
>(
  outputSchemaSource: TSchema,
  project: (data: unknown) => v.InferInput<TSchema>,
): McpToolOutputContract<unknown, TSchema, "explicit"> => ({
  outputSchema: deriveMcpOutputSchema(outputSchemaSource),
  outputSchemaSource,
  project,
  projection: "explicit",
});
