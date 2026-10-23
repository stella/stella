import type { TOptional, TSchema, TUnsafe } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Static } from "elysia";
import { t } from "elysia";

/**
 * Route schemas for self-authorizing (token) routes.
 *
 * Elysia validates route schemas before the handler runs. On a route that
 * authorizes itself from a caller-supplied credential, a strict route schema
 * therefore answers unauthenticated probes with 422 validation errors,
 * leaking the endpoint's existence (breaking 404-when-unconfigured
 * semantics) and its parameter shape. The contract enforced here:
 *
 * 1. The route schema is *permissive*: query/param properties are optional
 *    plain strings, while bodies accept any root value, so framework
 *    validation cannot reject a request before the handler's own credential
 *    check runs.
 * 2. The handler declares its strict schema separately and applies it via
 *    {@link validatePostAuth} only after authorization has succeeded.
 *
 * `TokenHandlerConfig` only accepts the branded schema types produced by
 * the factories below, so attaching a hand-built strict schema to a token
 * route is a compile error; the runtime marker makes a cast visible to the
 * token-route meta-test in `tests/security`.
 */

/**
 * Runtime counterpart of the compile-time brand. The factories stamp this
 * symbol on every schema they produce; the token-route meta-test asserts it
 * on each `createSafeTokenHandler` config, so bypassing the type with a
 * cast still fails a test.
 */
export const PERMISSIVE_ROUTE_SCHEMA_MARKER: unique symbol = Symbol.for(
  "stella.permissiveRouteSchema",
);

type PermissiveBrand = {
  readonly [PERMISSIVE_ROUTE_SCHEMA_MARKER]: true;
};

type PermissiveStatic<TKeys extends string> = Partial<Record<TKeys, string>>;

type PermissiveBodyStatic<TKeys extends string> = Partial<
  Record<TKeys, unknown>
>;

/**
 * Permissive schema for the `query` and `params` slots of a token route.
 * These slots always materialize as an object at runtime, so no optional
 * wrapper is needed.
 */
export type PermissiveRouteSchema<TKeys extends string = never> = TUnsafe<
  PermissiveStatic<TKeys>
> &
  PermissiveBrand;

/**
 * Permissive schema for the `body` slot of a token route. Optional at the
 * root so a probe with no body (or an unparseable one) reaches the handler
 * instead of failing framework validation.
 */
export type PermissiveBodySchema<
  TStringKeys extends string = never,
  TPassthroughKeys extends string = never,
> = TOptional<TUnsafe<PermissiveBodyStatic<TStringKeys | TPassthroughKeys>>> &
  PermissiveBrand;

/**
 * Any schema a token-route config slot accepts: produced by one of the
 * factories in this module, never hand-built.
 */
export type AnyPermissiveRouteSchema = TSchema & PermissiveBrand;

type PermissiveRouteSchemaOptions<
  TStringKeys extends readonly string[],
  TPassthroughKeys extends readonly string[] = [],
> = {
  /**
   * Property names the handler reads (typed `string | undefined`).
   * Properties outside this list still pass validation; the handler's
   * post-auth strict schema is the only authority on shape.
   */
  keys: TStringKeys;
  /**
   * Non-string fields the generated client must accept without validating
   * before authorization (for example, a multipart file part).
   */
  passthroughKeys?: TPassthroughKeys;
};

const buildPermissiveObject = (keys: readonly string[]) => {
  const properties: Record<string, TSchema> = {};
  for (const key of keys) {
    properties[key] = t.Optional(t.String());
  }
  // additionalProperties: true keeps Elysia's normalization from stripping
  // undeclared fields (e.g. a multipart file part), so the handler can
  // validate them post-auth.
  return t.Object(properties, { additionalProperties: true });
};

/**
 * Permissive schema for a token route's `query` or `params` slot: every
 * listed key is an optional plain string, everything else passes through.
 */
export const permissiveRouteSchema = <const TKeys extends readonly string[]>({
  keys,
}: PermissiveRouteSchemaOptions<TKeys>): PermissiveRouteSchema<TKeys[number]> =>
  Object.assign(
    Type.Unsafe<PermissiveStatic<TKeys[number]>>(buildPermissiveObject(keys)),
    { [PERMISSIVE_ROUTE_SCHEMA_MARKER]: true } satisfies PermissiveBrand,
  );

/**
 * Permissive schema for a token route's `body` slot. The runtime schema
 * accepts every root value so missing, malformed, or non-object probes cannot
 * produce a framework validation error. The unsafe static type still exposes
 * only the fields each handler reads; strict shape checks happen post-auth.
 */
export const permissiveBodySchema = <
  const TStringKeys extends readonly string[],
  const TPassthroughKeys extends readonly string[] = [],
>(
  _options: PermissiveRouteSchemaOptions<TStringKeys, TPassthroughKeys>,
): PermissiveBodySchema<TStringKeys[number], TPassthroughKeys[number]> =>
  Object.assign(
    t.Optional(
      Type.Unsafe<
        PermissiveBodyStatic<TStringKeys[number] | TPassthroughKeys[number]>
      >(t.Any()),
    ),
    { [PERMISSIVE_ROUTE_SCHEMA_MARKER]: true } satisfies PermissiveBrand,
  );

export type PostAuthValidation<TStrict extends TSchema> =
  | { ok: true; value: Static<TStrict> }
  | { ok: false; message: string };

/**
 * Applies a token route's strict schema to the raw (permissively routed)
 * value. Call this only after the handler's credential check has passed;
 * for credential fields themselves, a failure must map to the same
 * response as an unknown credential so malformed and unknown credentials
 * stay indistinguishable.
 *
 * `Value.Check` does not perform Elysia's route-level coercion. Callers whose
 * strict schemas expect numbers or booleans from query, params, or headers
 * must normalize those string inputs explicitly before validating them.
 */
export const validatePostAuth = <TStrict extends TSchema>(
  strictSchema: TStrict,
  rawValue: unknown,
): PostAuthValidation<TStrict> => {
  if (Value.Check(strictSchema, rawValue)) {
    return { ok: true, value: rawValue };
  }
  const firstError = Value.Errors(strictSchema, rawValue).First();
  if (!firstError) {
    return { ok: false, message: "Invalid request" };
  }
  const path = firstError.path === "" ? "value" : firstError.path;
  return { ok: false, message: `${path}: ${firstError.message}` };
};
