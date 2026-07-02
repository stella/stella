/**
 * Provider-safe JSON Schema projection.
 *
 * Chat tool JSON Schemas are handed to model providers verbatim by the
 * TanStack AI adapters (the Gemini adapter does zero sanitization). Google
 * Gemini's `function_declarations[].parameters` only accepts an OpenAPI-3.0
 * subset and rejects the whole request at JSON->proto parse time (HTTP 400
 * `Unknown name "propertyNames"`) when a tool schema carries an unsupported
 * keyword. One bad tool poisons every chat send.
 *
 * This module projects a JSON Schema into a portable subset with an
 * allowlist (not a blocklist, so new/unknown keywords fail closed). A few
 * semantics-preserving lowerings run first so common shapes survive
 * (`const` -> `enum`, `oneOf` -> `anyOf`, nullable type arrays -> `nullable`).
 * Everything outside the allowlist is dropped and recorded with a dotted path
 * so logs are actionable.
 *
 * Keep this module dependency-free: it operates on plain JSON objects and is
 * imported by both the first-party valibot funnel and the external-MCP
 * normalization seam.
 */

/**
 * Keywords Gemini's proto parser accepts inside `parameters`. Exported so the
 * registry CI guard asserts against the same single source of truth.
 *
 * `additionalProperties` is empirically accepted; `propertyNames` is not.
 */
export const PROVIDER_SAFE_JSON_SCHEMA_KEYWORDS = [
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "properties",
  "required",
  "items",
  "anyOf",
  "default",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "additionalProperties",
  "example",
] as const;

const ALLOWED_KEYWORDS = new Set<string>(PROVIDER_SAFE_JSON_SCHEMA_KEYWORDS);

type JsonObject = Record<string, unknown>;

export type ProviderSafeJsonSchemaProjection = {
  schema: Record<string, unknown>;
  droppedKeywords: readonly string[];
};

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const joinPath = (path: string, key: string): string =>
  path ? `${path}.${key}` : key;

/**
 * Semantics-preserving rewrites applied before the allowlist filter so common
 * draft-07 shapes survive projection instead of being dropped wholesale.
 */
const applyLowerings = (
  node: JsonObject,
  path: string,
  dropped: string[],
): JsonObject => {
  const next: JsonObject = { ...node };

  // const: X -> enum: [X]
  if ("const" in next) {
    const constValue = next["const"];
    delete next["const"];
    if (!("enum" in next)) {
      next["enum"] = [constValue];
    }
  }

  // oneOf: [...] -> anyOf: [...]
  if ("oneOf" in next && !("anyOf" in next)) {
    next["anyOf"] = next["oneOf"];
    delete next["oneOf"];
  }

  // Gemini's type enum has no "null"; nullability must be expressed via
  // `nullable: true`. Lower a scalar "null", then any type union: strip
  // "null" into `nullable`, keep the first remaining type, and record the
  // rest as dropped.
  const typeValue = next["type"];
  if (typeValue === "null") {
    delete next["type"];
    if (!("nullable" in next)) {
      next["nullable"] = true;
    }
    return next;
  }

  if (!Array.isArray(typeValue)) {
    return next;
  }

  const nonNull = typeValue.filter((entry) => entry !== "null");
  if (nonNull.length !== typeValue.length && !("nullable" in next)) {
    next["nullable"] = true;
  }

  if (nonNull.length === 0) {
    delete next["type"];
    return next;
  }

  next["type"] = nonNull[0];
  for (let index = 1; index < nonNull.length; index += 1) {
    dropped.push(`${joinPath(path, "type")}[${index}]`);
  }
  return next;
};

const projectChild = (
  key: string,
  value: unknown,
  path: string,
  dropped: string[],
): unknown => {
  if (key === "properties" && isJsonObject(value)) {
    const projectedProperties: JsonObject = {};
    for (const [propertyName, propertySchema] of Object.entries(value)) {
      projectedProperties[propertyName] = projectNode(
        propertySchema,
        joinPath(path, propertyName),
        dropped,
      );
    }
    return projectedProperties;
  }

  if (key === "additionalProperties" && isJsonObject(value)) {
    return projectNode(value, path, dropped);
  }

  if (key === "items") {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        projectNode(entry, `${path}[${index}]`, dropped),
      );
    }
    return projectNode(value, path, dropped);
  }

  if (key === "anyOf" && Array.isArray(value)) {
    return value.map((entry, index) =>
      projectNode(entry, `${path}[${index}]`, dropped),
    );
  }

  return value;
};

const projectNode = (
  node: unknown,
  path: string,
  dropped: string[],
): unknown => {
  if (!isJsonObject(node)) {
    return node;
  }

  const lowered = applyLowerings(node, path, dropped);
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(lowered)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      dropped.push(joinPath(path, key));
      continue;
    }
    result[key] = projectChild(key, value, joinPath(path, key), dropped);
  }
  return result;
};

/**
 * Project a JSON Schema into the provider-safe subset. Pure: returns a fresh
 * schema plus the dotted paths of every keyword that was dropped.
 */
export const projectToProviderSafeJsonSchema = (
  schema: Record<string, unknown>,
): ProviderSafeJsonSchemaProjection => {
  const dropped: string[] = [];
  const projected = projectNode(schema, "", dropped);
  const safeSchema = isJsonObject(projected) ? projected : schema;
  return { schema: safeSchema, droppedKeywords: dropped };
};
