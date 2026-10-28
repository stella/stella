import type { StandardSchemaV1 } from "@standard-schema/spec";

import { requestHeaders } from "@/api/http/context";
import type { HandlerContext } from "@/api/http/context";
import { decodeRequestInput } from "@/api/http/input";
import type { QueryRecord } from "@/api/http/input";
import type { AnySchema, RouteConfig, RouteRequest } from "@/api/http/route";
import { status } from "@/api/http/status";

/** A slot's decoded type: its schema's output, or the raw value when it declares none. */
type SlotOutput<TSchema, TFallback> = TSchema extends AnySchema
  ? StandardSchemaV1.InferOutput<TSchema>
  : TFallback;

export type RawParams = Readonly<Record<string, string>>;
export type RawHeaders = Record<string, string>;

/** The handler context a route config's schemas decode to. */
export type RouteContext<TConfig extends RouteConfig> = HandlerContext<
  SlotOutput<TConfig["params"], RawParams>,
  SlotOutput<TConfig["query"], QueryRecord>,
  SlotOutput<TConfig["body"], unknown>,
  SlotOutput<TConfig["headers"], RawHeaders>
>;

export type RouteInput<TConfig extends RouteConfig> = {
  readonly params: SlotOutput<TConfig["params"], RawParams>;
  readonly query: SlotOutput<TConfig["query"], QueryRecord>;
  readonly body: SlotOutput<TConfig["body"], unknown>;
  readonly headers: SlotOutput<TConfig["headers"], RawHeaders>;
};

/**
 * Decode a matched request's path, query and already-read body by its config.
 * Overloaded: the output type follows each slot's schema, which TypeScript
 * cannot relate to a runtime `undefined` check on a generic slot.
 */
export function decodeRouteInput<TConfig extends RouteConfig>(
  config: TConfig,
  request: RouteRequest,
  rawBody: unknown,
): Promise<RouteInput<TConfig>>;
export async function decodeRouteInput(
  config: RouteConfig,
  request: RouteRequest,
  rawBody: unknown,
): Promise<RouteInput<RouteConfig>> {
  const { ctx } = request;
  const headers = requestHeaders(ctx.request);
  return {
    params:
      config.params === undefined
        ? ctx.params
        : await decodeRequestInput(config.params, ctx.params),
    query:
      config.query === undefined
        ? ctx.query
        : await decodeRequestInput(config.query, ctx.query),
    body:
      config.body === undefined
        ? rawBody
        : await decodeRequestInput(config.body, rawBody),
    headers:
      config.headers === undefined
        ? headers
        : await decodeRequestInput(config.headers, headers),
  };
}

/** The context a route's handler sees, from the request and its decoded input. */
export const routeContext = <TConfig extends RouteConfig>(
  request: RouteRequest,
  input: RouteInput<TConfig>,
): RouteContext<TConfig> => ({
  request: request.ctx.request,
  server: request.ctx.server,
  path: request.ctx.path,
  route: request.route,
  routeEntry: request.ctx.routeEntry,
  set: request.ctx.set,
  headers: input.headers,
  status,
  params: input.params,
  query: input.query,
  body: input.body,
});
