/**
 * Advertised schemas. Whatever `tools/list` returns is resent on every turn,
 * so a listed schema carries the shape and nothing else: no descriptions, no
 * titles, no examples. Guidance lives in `describe_capability`.
 */

import type { McpJsonSchema, ListedTool } from "./types";

const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "$comment",
  "default",
  "description",
  "examples",
  "title",
]);

/** Keywords whose value is a map of property name to schema. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

const SCHEMA_ARRAY_KEYWORDS: ReadonlySet<string> = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

type SchemaChild = { name: string; depth: number };

/** Visit schema positions only; enum, const, and extension values are instance data. */
const mapSchemaChildren = (
  node: Record<string, unknown>,
  visit: (schema: unknown, child: SchemaChild) => unknown,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, schema]) => [
              name,
              visit(schema, { name, depth: 1 }),
            ]),
          ),
        ];
      }
      if (
        (SCHEMA_ARRAY_KEYWORDS.has(key) || key === "items") &&
        Array.isArray(value)
      ) {
        return [
          key,
          value.map((schema) => visit(schema, { name: key, depth: 0 })),
        ];
      }
      if (SCHEMA_KEYWORDS.has(key)) {
        return [key, visit(value, { name: key, depth: 0 })];
      }
      return [key, value];
    }),
  );

type CompactNodeOptions = Required<CompactSchemaOptions> & {
  depth: number;
};

const compactNode = (
  node: unknown,
  {
    depth,
    describedDepth,
    omitMaxSafeInteger,
    schemaDialect,
  }: CompactNodeOptions,
): unknown => {
  if (!isRecord(node)) {
    return node;
  }
  const compacted = mapSchemaChildren(node, (schema, child) =>
    compactNode(schema, {
      depth: depth + child.depth,
      describedDepth,
      omitMaxSafeInteger,
      schemaDialect,
    }),
  );
  return Object.fromEntries(
    Object.entries(compacted).filter(
      ([key, value]) =>
        !(
          omitMaxSafeInteger &&
          key === "maximum" &&
          value === Number.MAX_SAFE_INTEGER
        ) &&
        !(schemaDialect === "omit" && key === "$schema") &&
        (!ANNOTATION_KEYWORDS.has(key) ||
          (key === "description" && depth > 0 && depth <= describedDepth)),
    ),
  );
};

/** Options controlling descriptions retained in an advertised schema. */
export type CompactSchemaOptions = {
  /** Keep descriptions this many property levels deep; 0 (the default) keeps none. */
  describedDepth?: number;
  /** Advertising only: omit a ceiling the host separately enforces; never use for validation. Default: false. */
  omitMaxSafeInteger?: boolean;
  /** Omit a dialect only when the transport already fixes it. Default: preserve. */
  schemaDialect?: "preserve" | "omit";
};

/** The schema without annotation keywords, descriptions kept only as deep as asked. */
export const compactSchema = (
  schema: McpJsonSchema,
  {
    describedDepth = 0,
    omitMaxSafeInteger = false,
    schemaDialect = "preserve",
  }: CompactSchemaOptions = {},
): McpJsonSchema => {
  const compacted = compactNode(schema, {
    depth: 0,
    describedDepth,
    omitMaxSafeInteger,
    schemaDialect,
  });
  return isRecord(compacted) ? compacted : {};
};

type Occurrence = { count: number; name: string; bytes: number };

const REFERENCE_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "id",
  "$ref",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
]);

/** Moving a reference-bearing schema can change its resolution scope. */
const hasReferenceScope = (node: unknown): boolean => {
  if (!isRecord(node)) {
    return false;
  }
  if (Object.keys(node).some((key) => REFERENCE_KEYWORDS.has(key))) {
    return true;
  }
  let found = false;
  mapSchemaChildren(node, (schema) => {
    if (hasReferenceScope(schema)) {
      found = true;
    }
    return schema;
  });
  return found;
};

/**
 * Hoist repeated object schemas of at least `minBytes` into `$defs`.
 * Existing definitions and instance data are preserved. Schemas with reference
 * keywords remain unchanged because moving them could alter reference resolution.
 */
export const hoistRepeatedSchemas = (
  schema: McpJsonSchema,
  {
    minBytes = 200,
    definitionNames = "keyword",
  }: {
    minBytes?: number;
    /** Name union/item branches after their nearest property instead of the schema keyword. */
    definitionNames?: "keyword" | "property";
  } = {},
): McpJsonSchema => {
  if (hasReferenceScope(schema)) {
    return schema;
  }
  const seen = new Map<string, Occurrence>();
  const countSubschemas = (node: unknown, name: string): unknown => {
    if (!isRecord(node)) {
      return node;
    }
    const key = JSON.stringify(node);
    const occurrence = seen.get(key);
    if (occurrence === undefined) {
      seen.set(key, { count: 1, name, bytes: key.length });
    } else {
      occurrence.count += 1;
    }
    mapSchemaChildren(node, (child, info) =>
      countSubschemas(
        child,
        definitionNames === "property" && info.depth === 0 ? name : info.name,
      ),
    );
    return node;
  };
  mapSchemaChildren(schema, (child, info) => countSubschemas(child, info.name));
  const refs = new Map<string, string>();
  const existingDefs = isRecord(schema["$defs"]) ? schema["$defs"] : {};
  const defs = new Map(Object.entries(existingDefs));
  const repeated = [...seen.entries()]
    .filter(([, { count, bytes }]) => count > 1 && bytes >= minBytes)
    .toSorted(([, a], [, b]) => b.bytes - a.bytes);
  for (const [key, { name }] of repeated) {
    let defName = name;
    for (let suffix = 2; defs.has(defName); suffix += 1) {
      defName = `${name}${suffix}`;
    }
    refs.set(key, defName);
    defs.set(defName, null);
  }
  if (refs.size === 0) {
    return schema;
  }
  const replace = (node: unknown): unknown => {
    if (!isRecord(node)) {
      return node;
    }
    const ref = refs.get(JSON.stringify(node));
    if (ref !== undefined) {
      const pointer = ref.replaceAll("~", "~0").replaceAll("/", "~1");
      return { $ref: `#/$defs/${encodeURIComponent(pointer)}` };
    }
    return mapSchemaChildren(node, replace);
  };
  for (const [key, defName] of refs) {
    const definition: unknown = JSON.parse(key);
    if (isRecord(definition)) {
      defs.set(defName, mapSchemaChildren(definition, replace));
    }
  }
  const root = mapSchemaChildren(schema, replace);
  const replacedDefs = isRecord(root["$defs"]) ? root["$defs"] : {};
  for (const [name, definition] of Object.entries(replacedDefs)) {
    defs.set(name, definition);
  }
  return { ...root, $defs: Object.fromEntries(defs) };
};

/** The UTF-8 size of what `tools/list` sends for these tools. */
export const advertisedBytes = (tools: readonly ListedTool[]): number =>
  new TextEncoder().encode(JSON.stringify(tools)).length;
