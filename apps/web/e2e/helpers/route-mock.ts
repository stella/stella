/**
 * The one way a browser spec answers a request it intercepted.
 *
 * A hand-written response body is a second copy of the API contract that
 * nothing compares with the first: when the contract grows a field, the copy
 * keeps the old shape, the spec still compiles, and the app fails only in the
 * browser run. So every intercepted request is answered here, and every JSON
 * body is typed by the contract it stands in for:
 *
 * - `apiJson` types the body by the API route it answers, read off the same
 *   printed route types the app compiles against, so a body that drifts from
 *   the route is a type error in this project.
 * - `contractJson` parses the body with the shared schema of a route that is
 *   not in that route tree (an auth plugin's endpoint), so drift fails at the
 *   mock with the schema's message.
 * - `authJson` types the body of an auth library endpoint by the library's own
 *   response type.
 * - `apiError` builds the API's error envelope.
 * - `staticBody`, `eventStream` and `emptyReply` answer everything that is not
 *   JSON; their content types exclude JSON, so no body escapes the typing.
 *
 * The `no-raw-e2e-route-fulfill` lint rule keeps `route.fulfill` in this
 * module.
 */
import type { APIResponse, Route } from "@playwright/test";
import type { StreamChunk } from "@tanstack/ai/client";
import * as v from "valibot";

import type { ApiErrorObjectValue } from "@stll/api-contract";

import type { WebRoutes } from "../../src/generated/api-routes.gen";
import type { AuthEndpointBodies } from "../../src/lib/account/auth-endpoint-bodies";

type HttpMethod = "delete" | "get" | "patch" | "post" | "put";

/** The node of a route tree at a slash-separated path such as
 *  `v1/lists/:workspaceId/verifications/:runId`. */
type RouteNode<
  Tree,
  Path extends string,
> = Path extends `${infer Head}/${infer Rest}`
  ? Head extends keyof Tree
    ? RouteNode<Tree[Head], Rest>
    : never
  : Path extends keyof Tree
    ? Tree[Path]
    : never;

/** `never` for a path the tree does not hold: `keyof never` is every key, so
 *  the node is checked before it is indexed. */
type OkBody<Node, Method extends HttpMethod> = [Node] extends [never]
  ? never
  : Method extends keyof Node
    ? Node[Method] extends { response: { 200: infer Body } }
      ? Body
      : never
    : never;

/** The JSON body an API route answers with on success. */
export type ApiOk<Path extends string, Method extends HttpMethod> = OkBody<
  RouteNode<WebRoutes, Path>,
  Method
>;

/** A body for a path and method the route tree does not hold resolves to this
 *  message, so the spec's type error names the route it got wrong. */
type CheckedOk<Path extends string, Method extends HttpMethod> = [
  ApiOk<Path, Method>,
] extends [never]
  ? `${Uppercase<Method>} ${Path} is not an API route with a JSON 200 response`
  : ApiOk<Path, Method>;

type FulfillOptions = Exclude<Parameters<Route["fulfill"]>[0], undefined>;

const REPLY: unique symbol = Symbol("route reply");

/** A response a spec answers an intercepted request with. Only this module's
 *  builders make one: its key is not exported. */
export type RouteReply = { readonly [REPLY]: FulfillOptions };

const reply = (options: FulfillOptions): RouteReply => ({ [REPLY]: options });

type ReplyHeaders = Readonly<Record<string, string>>;

/** A success answer for an API route, typed by that route's response. */
export const apiJson = <
  const Path extends string,
  const Method extends HttpMethod,
>(
  _path: Path,
  _method: Method,
  body: NoInfer<CheckedOk<Path, Method>>,
  headers?: ReplyHeaders,
): RouteReply =>
  reply({ status: 200, json: body, ...(headers ? { headers } : {}) });

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;

/** An API failure in the API's error envelope. */
export const apiError = (
  status: ErrorStatus,
  body: ApiErrorObjectValue,
): RouteReply => reply({ status, json: body });

/** A JSON answer for an endpoint whose contract is a shared schema rather than
 *  an API route; the body must parse, so a stale mock fails here. */
export const contractJson = <const Schema extends v.GenericSchema>(
  schema: Schema,
  body: v.InferInput<Schema>,
  headers?: ReplyHeaders,
): RouteReply => {
  const parsed = v.safeParse(schema, body);
  if (!parsed.success) {
    throw new Error(
      `Mocked response does not match its contract: ${v.summarize(parsed.issues)}`,
    );
  }
  return reply({ status: 200, json: body, ...(headers ? { headers } : {}) });
};

/** The auth library's endpoints the specs answer. They sit outside the API
 *  route tree; `src/lib/account/auth-endpoint-bodies.type-test.ts` binds each body
 *  to the library's own endpoint result. */
type AuthResponses = AuthEndpointBodies;

/** The JSON body an auth library endpoint answers with. */
export type AuthOk<Endpoint extends keyof AuthResponses> =
  AuthResponses[Endpoint];

/** A success answer for an auth library endpoint. */
export const authJson = <const Endpoint extends keyof AuthResponses>(
  _endpoint: Endpoint,
  body: NoInfer<AuthOk<Endpoint>>,
): RouteReply => reply({ status: 200, json: body });

const JSON_BODY_HINT = "use apiJson, contractJson or authJson for a JSON body";

type NonJsonContentType<Type extends string> =
  Lowercase<Type> extends `${string}json${string}`
    ? typeof JSON_BODY_HINT
    : Type;

/** A non-JSON body: a page, a script, a stylesheet or a file. The content
 *  type is checked again at run time, in any letter case, and a header may
 *  not set it, so no JSON body leaves without its typed builder. */
export const staticBody = <const Type extends string>({
  contentType,
  body,
  headers,
}: {
  contentType: NonJsonContentType<Type>;
  body: string | Buffer;
  headers?: ReplyHeaders;
}): RouteReply => {
  if (/json/iu.test(contentType)) {
    throw new Error(`${contentType}: ${JSON_BODY_HINT}`);
  }
  if (
    headers !== undefined &&
    Object.keys(headers).some((name) => name.toLowerCase() === "content-type")
  ) {
    throw new Error("Set a static body's content type with `contentType`");
  }
  return reply({ contentType, body, ...(headers ? { headers } : {}) });
};

/** A server-sent event stream of chat chunks. */
export const eventStream = (events: readonly StreamChunk[]): RouteReply =>
  reply({
    contentType: "text/event-stream",
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  });

/** A response with a status and no body. */
export const emptyReply = (status: 204): RouteReply => reply({ status });

/** Answer an intercepted request. `response` keeps a fetched response's
 *  headers when the reply replaces only its body. */
export const respond = async (
  route: Pick<Route, "fulfill">,
  answer: RouteReply,
  options: { response?: APIResponse } = {},
): Promise<void> => {
  await route.fulfill({ ...options, ...answer[REPLY] });
};
