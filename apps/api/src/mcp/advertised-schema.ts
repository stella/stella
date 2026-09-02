import { KindGuard, type TSchema, Type } from "@sinclair/typebox";

/**
 * The `format` markers Elysia stamps on the string branch of a coercing scalar
 * (`t.Integer`, `t.Numeric`, `t.BooleanString`). Any other format on a string
 * branch is a real alternative the handler accepts, not a transport artifact.
 */
const COERCION_STRING_FORMATS = new Set(["integer", "numeric", "boolean"]);

const isCoercionStringBranch = (schema: TSchema): boolean =>
  KindGuard.IsString(schema) &&
  typeof schema.format === "string" &&
  COERCION_STRING_FORMATS.has(schema.format);

const isCoercibleScalar = (schema: TSchema): boolean =>
  KindGuard.IsNumber(schema) ||
  KindGuard.IsInteger(schema) ||
  KindGuard.IsBoolean(schema);

/**
 * The scalar branch of an Elysia coercion union, or `null` for every other
 * schema. `t.Integer({ minimum, maximum })` compiles to a two-variant union of
 * a coercing string branch (`{ type: "string", format: "integer", default: 0 }`)
 * and the real scalar, with the bounds hoisted onto the union node. That shape
 * leaks twice on the generic path: TypeBox enforces no keyword hoisted above a
 * union, and `Value.Convert` matches the string branch first, so `limit:
 * 100000` converts to `"100000"` and passes a schema advertising `maximum:
 * 200`. Flattening to the scalar branch is what makes the advertised bounds
 * enforceable; a JSON caller loses nothing, because `Value.Convert` still
 * coerces `"20"` to `20` against the scalar alone.
 */
const coercionUnionScalar = (schema: TSchema): TSchema | null => {
  if (!KindGuard.IsUnion(schema) || schema.anyOf.length !== 2) {
    return null;
  }
  const strings = schema.anyOf.filter(isCoercionStringBranch);
  const scalars = schema.anyOf.filter(isCoercibleScalar);
  if (strings.length !== 1 || scalars.length !== 1) {
    return null;
  }
  return scalars.at(0) ?? null;
};

/**
 * One input part's schema as every agent-facing surface advertises and
 * enforces it: `describe_capability` renders it, `invoke_capability` validates
 * against it, and the committed capability catalog (hence the CLI's generated
 * commands) embeds it, so what an agent reads and what the gate applies
 * cannot diverge.
 */
export const advertisedSchema = (schema: TSchema): TSchema => {
  const scalar = coercionUnionScalar(schema);
  if (scalar !== null) {
    // `t.Optional` marks the union node, never the branch inside it, so the
    // marker has to be carried across or a filter becomes required.
    return KindGuard.IsOptional(schema) ? Type.Optional(scalar) : scalar;
  }
  if (KindGuard.IsObject(schema)) {
    const properties: Record<string, TSchema> = {};
    for (const [key, property] of Object.entries(schema.properties)) {
      properties[key] = advertisedSchema(property);
    }
    return { ...schema, properties };
  }
  if (KindGuard.IsArray(schema)) {
    return { ...schema, items: advertisedSchema(schema.items) };
  }
  if (KindGuard.IsRecord(schema)) {
    const patternProperties: Record<string, TSchema> = {};
    for (const [pattern, property] of Object.entries(
      schema.patternProperties,
    )) {
      patternProperties[pattern] = advertisedSchema(property);
    }
    return { ...schema, patternProperties };
  }
  if (KindGuard.IsUnion(schema)) {
    return { ...schema, anyOf: schema.anyOf.map(advertisedSchema) };
  }
  if (KindGuard.IsIntersect(schema)) {
    return { ...schema, allOf: schema.allOf.map(advertisedSchema) };
  }
  return schema;
};

type EndpointInputParts = {
  body?: TSchema;
  params?: TSchema;
  query?: TSchema;
};

export type AdvertisedSchemas = {
  body: TSchema | undefined;
  params: TSchema | undefined;
  query: TSchema | undefined;
};

/** The three advertised part schemas of one capability's live endpoint config. */
export const advertisedSchemas = (
  config: EndpointInputParts,
): AdvertisedSchemas => ({
  body: config.body === undefined ? undefined : advertisedSchema(config.body),
  params:
    config.params === undefined ? undefined : advertisedSchema(config.params),
  query:
    config.query === undefined ? undefined : advertisedSchema(config.query),
});
