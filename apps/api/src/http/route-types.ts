/**
 * The browser's view of the routes, computed from their definitions: what a
 * client sends to each path and method, and what it gets back by status. Only
 * the web contract printer (`scripts/generate-web-api-types.ts`) evaluates
 * these types; apps/web reads the printed result.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { WireValueMetadata } from "@stll/api-contract/http-input";

import type { HttpMethod } from "@/api/http/route";
import type { HttpStatusResponse } from "@/api/http/status";

/** Stands in for a route the compiler cannot type; the printer refuses it. */
type RouteTypeError<TReason extends string> = {
  readonly "~routeTypeError": TReason;
};

type SchemaInput<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<TSchema>
  : unknown;

type SchemaOutput<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : unknown;

type WireMarker = {
  readonly type: "metadata";
  readonly metadata: WireValueMetadata;
};

/**
 * A schema that reads a string standing for its output (`numberFromString`),
 * also when a further pipe wraps it (`v.pipe(numberFromString(…), v.description(…))`):
 * a pipe's first item is the schema it refines.
 */
type IsWireSchema<TSchema> = TSchema extends {
  readonly pipe: readonly [infer TRoot, ...(infer TItems)[]];
}
  ? [Extract<TItems, WireMarker>] extends [never]
    ? IsWireSchema<TRoot>
    : true
  : false;

/**
 * What a client holds for one field: the value a wire field stands for, the
 * schema's input for any other. An optional or nullable wrapper keeps its own
 * `undefined` or `null`.
 */
type FieldValue<TSchema> =
  IsWireSchema<TSchema> extends true
    ? SchemaOutput<TSchema>
    : TSchema extends { readonly wrapped: infer TWrapped }
      ? IsWireSchema<TWrapped> extends true
        ? | Exclude<SchemaInput<TSchema>, string | readonly string[]>
          | SchemaOutput<TWrapped>
        : SchemaInput<TSchema>
      : SchemaInput<TSchema>;

type ObjectValue<TEntries, TInput> = {
  [TKey in keyof TInput]: TKey extends keyof TEntries
    ? FieldValue<TEntries[TKey]>
    : TInput[TKey];
};

/**
 * What a client sends for a request slot. Path, query and form values travel
 * as strings, so the client holds the values those strings stand for and the
 * transport writes them the way `toWireInput` does.
 */
type ClientInput<TSchema> = TSchema extends {
  readonly entries: infer TEntries;
}
  ? ObjectValue<TEntries, SchemaInput<TSchema>>
  : SchemaInput<TSchema>;

type ConfigOf<TDefinition> = TDefinition extends {
  readonly config: infer TConfig;
}
  ? TConfig
  : never;

/** A declared slot's client input; `unknown` when the route declares none. */
type Slot<
  TConfig,
  TName extends "body" | "params" | "query" | "headers",
> = TName extends keyof TConfig
  ? undefined extends TConfig[TName]
    ? unknown
    : ClientInput<TConfig[TName]>
  : unknown;

/**
 * Everything a route can answer. A safe handler's own `handler` is typed by
 * its factory; an endpoint's `run` carries its handler's answer.
 */
type AnswerOf<TDefinition> = TDefinition extends {
  readonly handler: (context: never) => Promise<infer TAnswer>;
}
  ? TAnswer
  : TDefinition extends {
        readonly run: (request: never) => Promise<infer TAnswer>;
      }
    ? TAnswer
    : unknown;

/** A status a type names; one only known as `number` cannot key a response. */
type LiteralCode<TCode> = number extends TCode ? never : TCode;

type AnswerCodes<TAnswer> =
  TAnswer extends HttpStatusResponse<infer TCode> ? LiteralCode<TCode> : 200;

type AnswerAt<TAnswer, TCode> =
  TAnswer extends HttpStatusResponse<infer TAnswerCode, infer TBody>
    ? TAnswerCode extends TCode
      ? TBody
      : never
    : TCode extends 200
      ? TAnswer
      : never;

type DeclaredResponses<TConfig> = TConfig extends {
  readonly response: infer TResponses;
}
  ? TResponses
  : Record<never, never>;

/**
 * A route's answers by status. A declared response schema decides its status
 * (its output is what is sent); the handler's own answers fill the rest.
 */
type RouteResponses<TDeclared, TAnswer> = {
  [
    TCode in keyof TDeclared | AnswerCodes<TAnswer>
  ]: TCode extends keyof TDeclared
    ? SchemaOutput<TDeclared[TCode]>
    : AnswerAt<TAnswer, TCode>;
};

type ReplayHeaders<TConfig> = TConfig extends {
  readonly idempotency: { readonly type: "replay" };
}
  ? { readonly "Idempotency-Key"?: string }
  : { readonly "Idempotency-Key"?: never };

/** What one route takes and answers, as the browser client is typed from it. */
type RouteIO<TDefinition> = {
  body: Slot<ConfigOf<TDefinition>, "body">;
  params: Slot<ConfigOf<TDefinition>, "params">;
  query: Slot<ConfigOf<TDefinition>, "query">;
  headers: Slot<ConfigOf<TDefinition>, "headers"> &
    ReplayHeaders<ConfigOf<TDefinition>>;
  response: RouteResponses<
    DeclaredResponses<ConfigOf<TDefinition>>,
    AnswerOf<TDefinition>
  >;
};

type RelativePath<TPath extends string> = TPath extends `/${infer TRest}`
  ? TRest
  : TPath;

type Relative<TRoutes> = {
  [TPath in keyof TRoutes & string as RelativePath<TPath>]: TRoutes[TPath];
};

type Head<TPath extends string> = TPath extends `${infer THead}/${string}`
  ? THead
  : TPath;

type Children<TRoutes> = Exclude<Head<keyof TRoutes & string>, "">;

type Below<TRoutes, TSegment extends string> = {
  [
    TPath in keyof TRoutes &
      string as TPath extends `${TSegment}/${infer TRest}`
      ? TRest
      : TPath extends TSegment
        ? ""
        : never
  ]: TRoutes[TPath];
};

type Here<TRoutes> = TRoutes extends { readonly "": infer TMethods }
  ? TMethods
  : Record<never, never>;

type MethodName<TMethods> = Lowercase<keyof TMethods & HttpMethod>;

type MethodRoute<TMethods, TName extends string> = {
  [TMethod in keyof TMethods & HttpMethod]: Lowercase<TMethod> extends TName
    ? TMethods[TMethod]
    : never;
}[keyof TMethods & HttpMethod];

/**
 * One path segment's routes: its methods by lower-cased name, and the
 * segments below it, a path parameter keeping its `:name`.
 */
type RouteNode<TRoutes> = {
  [
    TKey in Children<TRoutes> | MethodName<Here<TRoutes>>
  ]: TKey extends MethodName<Here<TRoutes>>
    ? TKey extends Children<TRoutes>
      ? RouteTypeError<"a path segment has the name of a method on the same path">
      : RouteIO<MethodRoute<Here<TRoutes>, TKey>>
    : RouteNode<Below<TRoutes, TKey>>;
};

/**
 * Full-path method routes (`RoutesOf` a group) as the segment tree a client
 * walks: `RouteTree<…>["v1"]["files"][":fileId"]["get"]`.
 */
export type RouteTree<TRoutes> = RouteNode<Relative<TRoutes>>;
