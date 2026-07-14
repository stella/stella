import { arrayOrEmpty } from "@/api/lib/array"; /**
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
const ALLOWED_TYPE_VALUES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

type JsonObject = Record<string, unknown>;

export type ProviderSafeJsonSchemaProjection = {
  schema: Record<string, unknown>;
  droppedKeywords: readonly string[];
};

export type NullUnionStrategy = "json-schema" | "openapi";
export type EnumValueStrategy = "json-schema" | "string-only";

export type ProviderSafeJsonSchemaProjectionOptions = {
  enumValueStrategy?: EnumValueStrategy;
  nullUnionStrategy?: NullUnionStrategy;
};

export const providerSafeJsonSchemaOptionsForTanStackProvider = (
  provider: string,
): ProviderSafeJsonSchemaProjectionOptions => ({
  enumValueStrategy:
    provider === "google" || provider === "openrouter"
      ? "string-only"
      : "json-schema",
  nullUnionStrategy: provider === "google" ? "openapi" : "json-schema",
});

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const joinPath = (path: string, key: string): string =>
  path ? `${path}.${key}` : key;

const jsonValueEquals = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const decodeJsonPointerSegment = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

const resolveLocalJsonPointer = (root: JsonObject, ref: string): unknown => {
  if (!ref.startsWith("#/")) {
    return undefined;
  }

  let current: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[decodeJsonPointerSegment(segment)];
  }
  return current;
};

type ProjectionContext = {
  root: JsonObject;
  dropped: string[];
  enumValueStrategy: EnumValueStrategy;
  nullUnionStrategy: NullUnionStrategy;
};

type NormalizeSchemaDialectParams = {
  node: JsonObject;
  path: string;
  context: ProjectionContext;
  seenRefs: ReadonlySet<string>;
};

type ProjectNodeParams = {
  node: unknown;
  path: string;
  context: ProjectionContext;
  seenRefs: ReadonlySet<string>;
};

const withBranchSiblings = (branch: unknown, siblings: JsonObject): unknown => {
  if (!isJsonObject(branch)) {
    return branch;
  }

  const candidate = { ...siblings };
  if (mergeJsonSchemaObject(candidate, branch)) {
    return candidate;
  }

  return { ...siblings, ...branch };
};

const branchesForTypes = (
  typeBranches: readonly string[],
  siblings: JsonObject,
): JsonObject[] => {
  const branches: JsonObject[] = [];
  for (const type of typeBranches) {
    branches.push({ type, ...siblings });
  }
  return branches;
};

const isAllowedTypeValue = (value: unknown): value is string =>
  typeof value === "string" && ALLOWED_TYPE_VALUES.has(value);

const normalizeConstKeyword = ({
  context,
  next,
  path,
}: {
  context: ProjectionContext;
  next: JsonObject;
  path: string;
}): void => {
  if (!("const" in next)) {
    return;
  }

  const constValue = next["const"];
  delete next["const"];
  const constType = typeof constValue;
  if (
    !("type" in next) &&
    (constType === "boolean" ||
      constType === "number" ||
      constType === "string")
  ) {
    next["type"] = constType;
  }

  if (constValue === null && !("enum" in next) && !("type" in next)) {
    if (context.nullUnionStrategy === "json-schema") {
      next["type"] = "null";
      return;
    }

    next["nullable"] = true;
    return;
  }

  if (
    !("enum" in next) &&
    (typeof constValue === "string" || typeof constValue === "number")
  ) {
    next["enum"] = [constValue];
    return;
  }

  context.dropped.push(joinPath(path, "const"));
};

const filterEnumValues = ({
  context,
  next,
  path,
}: {
  context: ProjectionContext;
  next: JsonObject;
  path: string;
}): void => {
  if (!isUnknownArray(next["enum"])) {
    return;
  }

  if (context.enumValueStrategy === "json-schema") {
    return;
  }

  const providerSafeValues: unknown[] = [];
  for (const [index, value] of next["enum"].entries()) {
    if (typeof value === "string") {
      providerSafeValues.push(value);
      continue;
    }
    if (value === null && context.nullUnionStrategy === "openapi") {
      next["nullable"] = true;
      continue;
    }
    context.dropped.push(`${joinPath(path, "enum")}[${index}]`);
  }

  if (providerSafeValues.length === 0) {
    delete next["enum"];
    return;
  }

  next["enum"] = providerSafeValues;
};

const normalizeLiteralKeywords = ({
  context,
  next,
  path,
}: {
  context: ProjectionContext;
  next: JsonObject;
  path: string;
}): void => {
  normalizeConstKeyword({ context, next, path });
  filterEnumValues({ context, next, path });
};

const stringArrayFrom = (value: unknown): string[] | null => {
  if (!isUnknownArray(value)) {
    return null;
  }

  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    strings.push(entry);
  }
  return strings;
};

const typeArrayFrom = (value: unknown): string[] | null => {
  if (typeof value === "string") {
    return [value];
  }
  return stringArrayFrom(value);
};

const numberFrom = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

const mergeRequired = (target: JsonObject, value: unknown): boolean => {
  const required = stringArrayFrom(value);
  if (!required) {
    return false;
  }

  const parsedExisting = stringArrayFrom(target["required"]);
  const existing = arrayOrEmpty(parsedExisting);
  target["required"] = Array.from(new Set([...existing, ...required]));
  return true;
};

const mergeEnum = (target: JsonObject, value: unknown): boolean => {
  if (!isUnknownArray(value)) {
    return false;
  }

  const existing = target["enum"];
  if (existing === undefined) {
    target["enum"] = value;
    return true;
  }
  if (!isUnknownArray(existing)) {
    return false;
  }

  const intersection = existing.filter((entry) =>
    value.some((candidate) => jsonValueEquals(candidate, entry)),
  );
  if (intersection.length === 0) {
    return false;
  }

  target["enum"] = intersection;
  return true;
};

const mergeAdditionalProperties = (
  target: JsonObject,
  value: unknown,
): boolean => {
  const existing = target["additionalProperties"];
  if (existing === false) {
    return true;
  }
  if (existing === undefined || existing === true) {
    target["additionalProperties"] = value;
    return true;
  }
  if (value === true || jsonValueEquals(existing, value)) {
    return true;
  }
  if (existing !== false && value === false) {
    target["additionalProperties"] = false;
    return true;
  }
  return false;
};

const mergeType = (target: JsonObject, value: unknown): boolean => {
  const incomingTypes = typeArrayFrom(value);
  if (!incomingTypes) {
    return false;
  }

  const existing = target["type"];
  if (existing === undefined) {
    target["type"] = value;
    return true;
  }

  const existingTypes = typeArrayFrom(existing);
  if (!existingTypes) {
    return false;
  }

  const incomingTypeSet = new Set(incomingTypes);
  const sharedTypes = existingTypes.filter((type) => incomingTypeSet.has(type));
  if (sharedTypes.length === 0) {
    return false;
  }

  if (
    existingTypes.includes("null") &&
    sharedTypes.some((type) => type !== "null")
  ) {
    target["type"] = existing;
    return true;
  }

  target["type"] = sharedTypes.length === 1 ? sharedTypes.at(0) : sharedTypes;
  return true;
};

const mergeNumberBound = ({
  mode,
  target,
  key,
  value,
}: {
  mode: "max" | "min";
  target: JsonObject;
  key: string;
  value: unknown;
}): boolean => {
  const next = numberFrom(value);
  if (next === null) {
    return false;
  }

  const existing = target[key];
  if (existing === undefined) {
    target[key] = next;
    return true;
  }

  const current = numberFrom(existing);
  if (current === null) {
    return false;
  }

  target[key] =
    mode === "max" ? Math.max(current, next) : Math.min(current, next);
  return true;
};

const mergeJsonSchemaKeyword = ({
  key,
  target,
  value,
}: {
  key: string;
  target: JsonObject;
  value: unknown;
}): boolean => {
  if (key === "properties") {
    return mergeProperties(target, value);
  }
  if (key === "required") {
    return mergeRequired(target, value);
  }
  if (key === "enum") {
    return mergeEnum(target, value);
  }
  if (key === "additionalProperties") {
    return mergeAdditionalProperties(target, value);
  }
  if (key === "type") {
    return mergeType(target, value);
  }
  if (key === "minimum" || key === "minItems" || key === "minLength") {
    return mergeNumberBound({ key, mode: "max", target, value });
  }
  if (key === "maximum" || key === "maxItems" || key === "maxLength") {
    return mergeNumberBound({ key, mode: "min", target, value });
  }

  const existing = target[key];
  if (existing === undefined) {
    target[key] = value;
    return true;
  }
  return jsonValueEquals(existing, value);
};

const mergeJsonSchemaObject = (
  target: JsonObject,
  source: JsonObject,
): boolean => {
  for (const [key, value] of Object.entries(source)) {
    if (!mergeJsonSchemaKeyword({ key, target, value })) {
      return false;
    }
  }
  return true;
};

const mergeProperties = (target: JsonObject, value: unknown): boolean => {
  if (!isJsonObject(value)) {
    return false;
  }

  const existingValue = target["properties"];
  const properties: JsonObject = isJsonObject(existingValue)
    ? { ...existingValue }
    : {};

  for (const [key, propertySchema] of Object.entries(value)) {
    const existingPropertySchema = properties[key];
    if (existingPropertySchema === undefined) {
      properties[key] = propertySchema;
      continue;
    }
    if (
      !isJsonObject(existingPropertySchema) ||
      !isJsonObject(propertySchema)
    ) {
      if (!jsonValueEquals(existingPropertySchema, propertySchema)) {
        return false;
      }
      continue;
    }

    const mergedPropertySchema = { ...existingPropertySchema };
    if (!mergeJsonSchemaObject(mergedPropertySchema, propertySchema)) {
      return false;
    }
    properties[key] = mergedPropertySchema;
  }

  target["properties"] = properties;
  return true;
};

const normalizeAllOfKeyword = ({
  context,
  next,
  path,
  seenRefs,
}: {
  context: ProjectionContext;
  next: JsonObject;
  path: string;
  seenRefs: ReadonlySet<string>;
}): JsonObject => {
  if (!isUnknownArray(next["allOf"])) {
    return next;
  }

  const droppedKeywordCount = context.dropped.length;
  const candidate = { ...next };
  delete candidate["allOf"];
  for (const [index, branch] of next["allOf"].entries()) {
    if (!isJsonObject(branch)) {
      context.dropped.length = droppedKeywordCount;
      return next;
    }
    const projectedBranch = projectNode({
      node: branch,
      path: `${joinPath(path, "allOf")}[${index}]`,
      context,
      seenRefs,
    });
    if (!isJsonObject(projectedBranch)) {
      context.dropped.length = droppedKeywordCount;
      return next;
    }
    if (!mergeJsonSchemaObject(candidate, projectedBranch)) {
      context.dropped.length = droppedKeywordCount;
      return next;
    }
  }

  return candidate;
};

const isNullOnlySchema = (entry: JsonObject): boolean => {
  if (entry["type"] === "null" || entry["const"] === null) {
    return true;
  }

  const entryType = entry["type"];
  if (
    isUnknownArray(entryType) &&
    entryType.length > 0 &&
    entryType.every((value) => value === "null")
  ) {
    return true;
  }

  const entryEnum = entry["enum"];
  return (
    isUnknownArray(entryEnum) &&
    entryEnum.length > 0 &&
    entryEnum.every((value) => value === null)
  );
};

const normalizeAnyOfKeyword = ({
  context,
  next,
  path,
  seenRefs,
}: {
  context: ProjectionContext;
  next: JsonObject;
  path: string;
  seenRefs: ReadonlySet<string>;
}): JsonObject => {
  if (!isUnknownArray(next["anyOf"])) {
    return next;
  }

  const anyOf = next["anyOf"];
  if (context.nullUnionStrategy === "json-schema") {
    if (Object.keys(next).length <= 1) {
      return next;
    }

    const branchSiblings = { ...next };
    delete branchSiblings["anyOf"];
    return {
      anyOf: anyOf.map((branch) => withBranchSiblings(branch, branchSiblings)),
    };
  }

  const nonNullBranches = anyOf.filter((entry) => {
    if (!isJsonObject(entry)) {
      return true;
    }
    return !isNullOnlySchema(entry);
  });

  if (nonNullBranches.length !== anyOf.length && !("nullable" in next)) {
    next["nullable"] = true;
  }

  if (nonNullBranches.length === 0) {
    delete next["anyOf"];
    return next;
  }

  const branchSiblings = { ...next };
  delete branchSiblings["anyOf"];
  const branch = nonNullBranches.at(0);
  if (nonNullBranches.length === 1 && isJsonObject(branch)) {
    const mergedBranch = withBranchSiblings(branch, branchSiblings);
    return normalizeSchemaDialect({
      node: isJsonObject(mergedBranch) ? mergedBranch : branch,
      path,
      context,
      seenRefs,
    });
  }

  if (Object.keys(branchSiblings).length > 0) {
    return {
      anyOf: nonNullBranches.map((entry) =>
        withBranchSiblings(entry, branchSiblings),
      ),
    };
  }

  next["anyOf"] = nonNullBranches;
  return next;
};

const normalizeTypeKeyword = ({
  context,
  next,
  path,
}: {
  context: ProjectionContext;
  next: JsonObject;
  path: string;
}): JsonObject => {
  const typeValue = next["type"];
  if (typeValue === "null") {
    if (context.nullUnionStrategy === "json-schema") {
      return next;
    }
    delete next["type"];
    if (!("nullable" in next)) {
      next["nullable"] = true;
    }
    return next;
  }

  if (!isUnknownArray(typeValue)) {
    if (typeValue !== undefined && !isAllowedTypeValue(typeValue)) {
      delete next["type"];
      context.dropped.push(joinPath(path, "type"));
    }
    return next;
  }

  const typeBranches: string[] = [];
  const sawNullType = typeValue.includes("null");
  for (const [index, entry] of typeValue.entries()) {
    if (entry === "null") {
      if (context.nullUnionStrategy === "json-schema") {
        typeBranches.push(entry);
      }
      continue;
    }
    if (isAllowedTypeValue(entry)) {
      typeBranches.push(entry);
      continue;
    }
    context.dropped.push(`${joinPath(path, "type")}[${index}]`);
  }

  if (
    context.nullUnionStrategy === "openapi" &&
    sawNullType &&
    !("nullable" in next)
  ) {
    next["nullable"] = true;
  }

  if (typeBranches.length === 0) {
    delete next["type"];
    return next;
  }

  if (typeBranches.length === 1) {
    next["type"] = typeBranches.at(0);
    return next;
  }

  const branchSiblings = { ...next };
  delete branchSiblings["type"];
  delete next["type"];
  if (!("anyOf" in next)) {
    return { anyOf: branchesForTypes(typeBranches, branchSiblings) };
  }

  return next;
};

/**
 * Semantics-preserving rewrites applied before the allowlist filter so common
 * draft-07 shapes survive projection instead of being dropped wholesale.
 */
const normalizeSchemaDialect = ({
  node,
  path,
  context,
  seenRefs,
}: NormalizeSchemaDialectParams): JsonObject => {
  const next: JsonObject = { ...node };

  normalizeLiteralKeywords({ context, next, path });

  const allOfLowered = normalizeAllOfKeyword({ context, next, path, seenRefs });

  // oneOf: [...] -> anyOf: [...]
  if ("oneOf" in allOfLowered && !("anyOf" in allOfLowered)) {
    allOfLowered["anyOf"] = allOfLowered["oneOf"];
    delete allOfLowered["oneOf"];
  }

  return normalizeTypeKeyword({
    context,
    next: normalizeAnyOfKeyword({
      context,
      next: allOfLowered,
      path,
      seenRefs,
    }),
    path,
  });
};

type ProjectChildParams = {
  key: string;
  value: unknown;
  path: string;
  context: ProjectionContext;
  seenRefs: ReadonlySet<string>;
};

const projectChild = ({
  key,
  value,
  path,
  context,
  seenRefs,
}: ProjectChildParams): unknown => {
  if (key === "properties" && isJsonObject(value)) {
    const projectedProperties: JsonObject = {};
    for (const [propertyName, propertySchema] of Object.entries(value)) {
      projectedProperties[propertyName] = projectNode({
        node: propertySchema,
        path: joinPath(path, propertyName),
        context,
        seenRefs,
      });
    }
    return projectedProperties;
  }

  if (key === "additionalProperties" && isJsonObject(value)) {
    return projectNode({ node: value, path, context, seenRefs });
  }

  if (key === "items") {
    if (Array.isArray(value)) {
      context.dropped.push(path);
      if (value.length === 0) {
        return {};
      }
      return {
        anyOf: value.map((entry, index) =>
          projectNode({
            node: entry,
            path: `${path}[${index}]`,
            context,
            seenRefs,
          }),
        ),
      };
    }
    return projectNode({ node: value, path, context, seenRefs });
  }

  if (key === "anyOf" && Array.isArray(value)) {
    return value.map((entry, index) =>
      projectNode({
        node: entry,
        path: `${path}[${index}]`,
        context,
        seenRefs,
      }),
    );
  }

  return value;
};

const resolveReferencedNode = ({
  context,
  node,
  path,
  seenRefs,
}: {
  context: ProjectionContext;
  node: JsonObject;
  path: string;
  seenRefs: ReadonlySet<string>;
}): ProjectNodeParams | null => {
  const ref = node["$ref"];
  if (typeof ref !== "string" || seenRefs.has(ref)) {
    return null;
  }

  const referenced = resolveLocalJsonPointer(context.root, ref);
  if (!isJsonObject(referenced)) {
    return null;
  }

  const overrides = { ...node };
  delete overrides["$ref"];
  context.dropped.push(joinPath(path, "$ref"));
  return {
    node: { ...referenced, ...overrides },
    path,
    context,
    seenRefs: new Set([...seenRefs, ref]),
  };
};

const filterProviderSafeKeywords = ({
  context,
  node,
  path,
  seenRefs,
}: {
  context: ProjectionContext;
  node: JsonObject;
  path: string;
  seenRefs: ReadonlySet<string>;
}): JsonObject => {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      context.dropped.push(joinPath(path, key));
      continue;
    }
    result[key] = projectChild({
      key,
      value,
      path: joinPath(path, key),
      context,
      seenRefs,
    });
  }
  return result;
};

const projectNode = ({
  node,
  path,
  context,
  seenRefs,
}: ProjectNodeParams): unknown => {
  if (typeof node === "boolean") {
    if (!node) {
      context.dropped.push(path);
    }
    return {};
  }

  if (!isJsonObject(node)) {
    return node;
  }

  // Provider projection is intentionally staged: resolve local references,
  // normalize JSON Schema dialect features, then apply the provider allowlist.
  const referencedNode = resolveReferencedNode({
    context,
    node,
    path,
    seenRefs,
  });
  if (referencedNode) {
    return projectNode(referencedNode);
  }

  const normalized = normalizeSchemaDialect({ node, path, context, seenRefs });
  return filterProviderSafeKeywords({
    node: normalized,
    path,
    context,
    seenRefs,
  });
};

/**
 * Project a JSON Schema into the provider-safe subset. Pure: returns a fresh
 * schema plus the dotted paths of every keyword that was dropped.
 */
export const projectToProviderSafeJsonSchema = (
  schema: Record<string, unknown>,
  options: ProviderSafeJsonSchemaProjectionOptions = {},
): ProviderSafeJsonSchemaProjection => {
  const nullUnionStrategy = options.nullUnionStrategy ?? "json-schema";
  const context: ProjectionContext = {
    root: schema,
    dropped: [],
    enumValueStrategy:
      options.enumValueStrategy ??
      (nullUnionStrategy === "openapi" ? "string-only" : "json-schema"),
    nullUnionStrategy,
  };
  const projected = projectNode({
    node: schema,
    path: "",
    context,
    seenRefs: new Set(),
  });
  const safeSchema = isJsonObject(projected) ? projected : schema;
  return { schema: safeSchema, droppedKeywords: context.dropped };
};
