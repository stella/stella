import { panic } from "better-result";
import type * as v from "valibot";

import {
  AGENT_INPUT_NORMALIZATION_KIND,
  agentInputNormalizationMetadata,
  type AgentInputNormalizationAnnotation,
} from "@stll/agent-input";

import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { isUnknownArray } from "@/api/lib/type-guards";
import type {
  McpToolDefinition,
  McpToolAnnotationReasons,
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

type ToolWithoutInputSchema<TDefinition> = TDefinition extends McpToolDefinition
  ? Omit<TDefinition, "annotationReasons" | "inputSchema">
  : never;

type ValibotMcpToolInput = ToolWithoutInputSchema<McpToolDefinition> & {
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
  annotationReasons: McpToolAnnotationReasons;
  inputSchema: McpToolInputSchema;
  inputSchemaSource: TDefinition["inputSchema"];
  inputSchemaProjectionWaiver: JsonSchemaProjectionWaiver | undefined;
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

/**
 * Kinds a property's name declares on every tool, so a new tool inherits them
 * instead of opting in:
 *
 * - `limit` is a page size: a server limit, not a meaning. A caller asking for
 *   500 rows where a page holds 100 wants the most there is, so the value is
 *   clamped with a note rather than refused.
 * - `date_from` / `date_to` are the ends of a range: a bare year or month
 *   names its first day on the start and its last on the end, and an
 *   open-ended sentinel (`0001-01-01`, `9999-12-31`) reads as no bound.
 *
 * A tool's own plan for the same property wins.
 */
const CONVENTIONAL_PROPERTY_NORMALIZATION = [
  {
    property: "limit",
    applies: (schema: Record<string, unknown>) =>
      typeof schema["maximum"] === "number",
    annotation: { kind: AGENT_INPUT_NORMALIZATION_KIND.number, range: "clamp" },
  },
  {
    property: "date_from",
    applies: (schema: Record<string, unknown>) => schema["format"] === "date",
    annotation: { kind: AGENT_INPUT_NORMALIZATION_KIND.date, bound: "start" },
  },
  {
    property: "date_to",
    applies: (schema: Record<string, unknown>) => schema["format"] === "date",
    annotation: { kind: AGENT_INPUT_NORMALIZATION_KIND.date, bound: "end" },
  },
] as const satisfies readonly {
  property: string;
  applies: (schema: Record<string, unknown>) => boolean;
  annotation: AgentInputNormalizationAnnotation;
}[];

/** The plan with the conventional kinds added for the properties carrying them. */
const withConventionalNormalization = (
  schema: McpToolInputSchema,
  plan: Readonly<Record<string, AgentInputNormalizationAnnotation>> | undefined,
): Readonly<Record<string, AgentInputNormalizationAnnotation>> | undefined => {
  const conventional = CONVENTIONAL_PROPERTY_NORMALIZATION.filter((rule) => {
    const property = schema.properties?.[rule.property];
    return (
      plan?.[rule.property] === undefined &&
      isSchemaRecord(property) &&
      rule.applies(property)
    );
  });
  return conventional.length === 0
    ? plan
    : {
        ...plan,
        ...Object.fromEntries(
          conventional.map((rule) => [rule.property, rule.annotation]),
        ),
      };
};

const applyInputNormalizationPlan = (
  schema: McpToolInputSchema,
  explicitPlan:
    | Readonly<Record<string, AgentInputNormalizationAnnotation>>
    | undefined,
): McpToolInputSchema => {
  const plan = withConventionalNormalization(schema, explicitPlan);
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

/**
 * `equivalent` folds alternatives into shorter schemas that accept exactly the
 * same values; `none` is the projection without those folds, kept only so a
 * test can prove the equivalence on the real registry.
 */
type OutputSchemaCompaction = "equivalent" | "none";

const deriveMcpOutputSchema = (
  schema: v.GenericSchema,
  customSchemaProjection: "none" | "chat-string-ids" = "none",
  compaction: OutputSchemaCompaction = "equivalent",
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
    simplifyMcpOutputSchema(projectSchemaKeywords(jsonSchema), compaction),
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
  return compaction === "equivalent"
    ? nullableAsTypeArray(projected)
    : projected;
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

/**
 * The type of a branch that is exactly `{ type, enum }`, a literal list
 * `projectSchemaKeywords` makes of `v.literal` and `v.picklist`. A branch
 * carrying any other keyword is never a literal list here.
 */
const literalListType = (
  schema: Record<string, unknown>,
): string | undefined => {
  const type = schema["type"];
  return typeof type === "string" &&
    Array.isArray(schema["enum"]) &&
    Object.keys(schema).length === 2
    ? type
    : undefined;
};

/**
 * Folds literal-list alternatives of one type into a single list: a value
 * matches some `{ type: T, enum: Ei }` exactly when it is a `T` in the union
 * of the `Ei`. Every other alternative stays as it is and where it is.
 */
const mergeLiteralAlternatives = (
  schemas: readonly Record<string, unknown>[],
): Record<string, unknown>[] => {
  const merged: Record<string, unknown>[] = [];
  const listIndexByType = new Map<string, number>();
  for (const schema of schemas) {
    const type = literalListType(schema);
    const index = type === undefined ? undefined : listIndexByType.get(type);
    const list = index === undefined ? undefined : merged[index];
    if (type === undefined || index === undefined || list === undefined) {
      if (type !== undefined) {
        listIndexByType.set(type, merged.length);
      }
      merged.push(schema);
      continue;
    }
    merged[index] = {
      ...list,
      enum: unionOfLiterals(list["enum"], schema["enum"]),
    };
  }
  return merged;
};

const unionOfLiterals = (left: unknown, right: unknown): unknown[] => {
  const seen = new Set<string>();
  return [
    ...(isUnknownArray(left) ? left : []),
    ...(isUnknownArray(right) ? right : []),
  ].filter((literal) => {
    const key = JSON.stringify(literal);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const combineSchemas = (
  schemas: readonly Record<string, unknown>[],
  compaction: OutputSchemaCompaction,
): Record<string, unknown> => {
  const unique = uniqueSchemas(schemas);
  const combined =
    compaction === "equivalent" ? mergeLiteralAlternatives(unique) : unique;
  return combined.length === 1 ? (combined.at(0) ?? {}) : { anyOf: combined };
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
 * as `anyOf`, their literal lists of one type folded into one. The executable
 * Valibot source remains exact at dispatch.
 */
const mergeObjectUnion = (
  branches: readonly unknown[],
  compaction: OutputSchemaCompaction,
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
    properties[name] = combineSchemas(schemas, compaction);
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
 * pass only deduplicates alternatives, folds literal lists and merges object
 * unions with the widening rule above; it never guesses which domain fields
 * are unimportant.
 */
const simplifyMcpOutputSchema = (
  schema: Record<string, unknown>,
  compaction: OutputSchemaCompaction,
): Record<string, unknown> => {
  const simplified: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isSchemaRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, nested] of Object.entries(value)) {
        mapped[name] = isSchemaRecord(nested)
          ? simplifyMcpOutputSchema(nested, compaction)
          : nested;
      }
      simplified[key] = mapped;
      continue;
    }
    if (Array.isArray(value)) {
      simplified[key] = value.map((nested: unknown) =>
        isSchemaRecord(nested)
          ? simplifyMcpOutputSchema(nested, compaction)
          : nested,
      );
      continue;
    }
    simplified[key] = isSchemaRecord(value)
      ? simplifyMcpOutputSchema(value, compaction)
      : value;
  }

  const alternatives = simplified["anyOf"];
  if (!Array.isArray(alternatives) || !alternatives.every(isSchemaRecord)) {
    return simplified;
  }
  const unique = uniqueSchemas(alternatives);
  const combined =
    compaction === "equivalent" ? mergeLiteralAlternatives(unique) : unique;
  const { anyOf: _alternatives, ...siblings } = simplified;
  // Literal lists that merged into one alternative replace the `anyOf`.
  const literalList =
    combined.length === 1 && unique.length > 1 ? combined.at(0) : undefined;
  if (
    literalList !== undefined &&
    Object.keys(literalList).every((key) => !(key in siblings))
  ) {
    return { ...siblings, ...literalList };
  }
  if (combined.length !== alternatives.length) {
    simplified["anyOf"] = combined;
  }
  const merged = mergeObjectUnion(combined, compaction);
  if (merged === undefined) {
    return simplified;
  }
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
 * Keywords that constrain only instances of one JSON type, so `null` satisfies
 * each of them vacuously. A branch built from `type` and these alone accepts
 * `null` exactly when its `type` admits it.
 */
const TYPE_SCOPED_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "dependencies",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "patternProperties",
  "properties",
  "propertyNames",
  "required",
  "uniqueItems",
]);

const isNullSchema = (schema: unknown): boolean =>
  isSchemaRecord(schema) &&
  schema["type"] === "null" &&
  Object.keys(schema).length === 1;

/**
 * `anyOf: [S, { type: "null" }]` becomes S with `type: [T, "null"]` when S is
 * one `type: T` plus type-scoped keywords only: both accept `null`, and both
 * accept a `T` exactly when S does. A branch with `enum`, a combinator or any
 * other keyword that also constrains `null` keeps its `anyOf`, as does a node
 * whose own keywords would collide with S's. Runs after the depth widening,
 * which reads `type: "object"` literally.
 */
const nullableAsTypeArray = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isSchemaRecord(value)) {
      rewritten[key] = Object.fromEntries(
        Object.entries(value).map(([name, nested]): [string, unknown] => [
          name,
          isSchemaRecord(nested) ? nullableAsTypeArray(nested) : nested,
        ]),
      );
      continue;
    }
    if (Array.isArray(value)) {
      rewritten[key] = value.map((nested: unknown) =>
        isSchemaRecord(nested) ? nullableAsTypeArray(nested) : nested,
      );
      continue;
    }
    rewritten[key] = isSchemaRecord(value) ? nullableAsTypeArray(value) : value;
  }

  const { anyOf, ...siblings } = rewritten;
  if (!Array.isArray(anyOf) || anyOf.length !== 2) {
    return rewritten;
  }
  const nullIndex = anyOf.findIndex(isNullSchema);
  const branch: unknown = anyOf.at(1 - nullIndex);
  if (nullIndex === -1 || !isSchemaRecord(branch)) {
    return rewritten;
  }
  const type = branch["type"];
  if (
    typeof type !== "string" ||
    type === "null" ||
    !Object.keys(branch).every(
      (key) =>
        (key === "type" || TYPE_SCOPED_KEYWORDS.has(key)) && !(key in siblings),
    )
  ) {
    return rewritten;
  }
  return { ...siblings, ...branch, type: [type, "null"] };
};

/**
 * Defines a native tool from the same Valibot schema its handler parses.
 * `inputSchemaSource` retains that actual schema as internal registry metadata:
 * handlers parse through the definition, while wire projection selects only
 * MCP protocol fields. A compile-time check in `static-tool-definitions.ts`
 * requires its presence on every native tool.
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
  const { annotations } = toolDefinition;
  const subject = annotations.title;
  let destructiveHintReason = `${subject} is additive and does not overwrite or remove existing state.`;
  if (annotations.readOnlyHint) {
    destructiveHintReason = `${subject} does not change state.`;
  }
  if (annotations.destructiveHint) {
    destructiveHintReason = `${subject} can overwrite, delete, cancel, revoke, or otherwise irreversibly change existing state.`;
  }
  return {
    ...toolDefinition,
    annotationReasons: {
      readOnlyHint: annotations.readOnlyHint
        ? `${subject} only retrieves or computes data.`
        : `${subject} changes state or starts stateful work.`,
      destructiveHint: destructiveHintReason,
      openWorldHint: annotations.openWorldHint
        ? `${subject} can access public or external entities outside the private workspace.`
        : `${subject} is confined to the private workspace or a bounded computation.`,
    },
    inputSchema: applyInputNormalizationPlan(
      deriveMcpInputSchema(
        inputSchema.advertisedSchema,
        jsonSchemaProjectionWaiver,
      ),
      inputNormalization,
    ),
    inputSchemaSource: inputSchema,
    inputSchemaProjectionWaiver: jsonSchemaProjectionWaiver,
  };
};

/**
 * Defines the input contract of a dynamic tool family, whose definitions are
 * built per tenant rather than through `defineValibotMcpTool`: the advertised
 * JSON Schema and the schema dispatch parses with come from one Valibot source.
 */
export const defineMcpToolInput = <
  const TSchema extends NullAsAbsentInputSchema,
>(
  inputSchemaSource: TSchema,
): { inputSchema: McpToolInputSchema; inputSchemaSource: TSchema } => ({
  inputSchema: applyInputNormalizationPlan(
    deriveMcpInputSchema(inputSchemaSource.advertisedSchema, undefined),
    undefined,
  ),
  inputSchemaSource,
});

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

/**
 * The published output projection without its equivalent compaction, read
 * only by the test that proves the compaction accepts exactly the same values.
 * The chat string-id projection is safe for every source: a schema it changes
 * cannot be defined without it.
 */
export const deriveUncompactedMcpOutputSchema = (
  outputSchemaSource: v.GenericSchema,
): McpToolOutputSchema =>
  deriveMcpOutputSchema(outputSchemaSource, "chat-string-ids", "none");

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
