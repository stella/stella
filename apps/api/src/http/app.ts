import { panic } from "better-result";
import type { BunRequest } from "bun";

import { createResponseSet } from "@/api/http/context";
import type { HttpServer, RequestContext } from "@/api/http/context";
import { HTTP_FAILURE, HttpFailureError } from "@/api/http/errors";
import { encodeResponseOutput, parseQuery, readBody } from "@/api/http/input";
import type { QueryRecord } from "@/api/http/input";
import { toResponse } from "@/api/http/respond";
import type {
  AnySchema,
  HttpMethod,
  Middleware,
  RouteEntry,
} from "@/api/http/route";
import { HttpStatusResponse, unwrapStatus } from "@/api/http/status";

export type HttpAppOptions = {
  readonly routes: readonly RouteEntry[];
  /** Stages every request passes through, outermost first. */
  readonly middleware: readonly Middleware[];
};

type PathRoutes = {
  readonly pattern: string;
  readonly byMethod: ReadonlyMap<HttpMethod, RouteEntry>;
};

type BunRouteHandler = (
  request: BunRequest,
  server: HttpServer,
) => Promise<Response>;

const isWebRequest = (value: unknown): value is Request =>
  value instanceof Request;

type Next = (ctx: RequestContext) => Promise<Response>;

/**
 * The stages folded into one function when the app is built, outermost
 * first. A request then runs each stage once with no per-stage wrapper of its
 * own: the pipeline is about twenty stages deep, and an awaiting wrapper per
 * stage per request was a fifth of the time of a request that never reaches a
 * handler.
 */
const chain = (stages: readonly Middleware[], last: Next): Next => {
  let next = last;
  for (const stage of stages.toReversed()) {
    const inner = next;
    next = async (ctx) =>
      stage(ctx, async (replacement) => inner(replacement ?? ctx));
  }
  return next;
};

const METHOD_BY_NAME: Readonly<Partial<Record<string, HttpMethod>>> = {
  GET: "GET",
  HEAD: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE",
  OPTIONS: "OPTIONS",
};

const entryFor = (
  routes: PathRoutes | undefined,
  method: string,
): RouteEntry | undefined => {
  const lookup = METHOD_BY_NAME[method];
  return routes === undefined || lookup === undefined
    ? undefined
    : routes.byMethod.get(lookup);
};

/** Bytes, streams and raw responses are sent as they are, never re-encoded. */
const isRawAnswer = (value: unknown): boolean =>
  value instanceof Response ||
  value instanceof Blob ||
  value instanceof ReadableStream ||
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value);

const encodeAnswer = async (
  entry: RouteEntry,
  answer: unknown,
  ctx: RequestContext,
): Promise<unknown> => {
  const { value, code } = unwrapStatus(answer);
  if (isRawAnswer(value)) {
    return answer;
  }
  const schema: AnySchema | undefined =
    entry.definition.config.response?.[code ?? ctx.set.status ?? 200];
  if (schema === undefined) {
    return answer;
  }
  const encoded = await encodeResponseOutput(schema, value);
  return code === undefined ? encoded : new HttpStatusResponse(code, encoded);
};

const withoutBody = (response: Response): Response =>
  new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

const indexRoutes = (
  routes: readonly RouteEntry[],
): Map<string, PathRoutes> => {
  const byPath = new Map<string, Map<HttpMethod, RouteEntry>>();
  for (const entry of routes) {
    const methods = byPath.get(entry.path) ?? new Map<HttpMethod, RouteEntry>();
    if (methods.has(entry.method)) {
      panic(`Route ${entry.method} ${entry.path} is mounted twice`);
    }
    methods.set(entry.method, entry);
    byPath.set(entry.path, methods);
  }
  return new Map(
    [...byPath].map(([pattern, byMethod]) => [pattern, { pattern, byMethod }]),
  );
};

/**
 * Keep-alive idle timeout in seconds: longer than the load balancer's 60 s
 * idle timeout (Bun defaults to 10 s). The balancer may reuse an idle backend
 * connection any time before its own timeout expires, so the server must
 * never close first: a request written onto a connection the server is
 * closing is lost in flight and the client hangs with no response and no
 * server-side log line. The SSE keep-alive heartbeat (20 s) stays well inside
 * this window, and so does a public read's 30 s statement timeout.
 */
const HTTP_IDLE_TIMEOUT_S = 75;

export type HttpApp = {
  /** Every mounted route, for tooling and censuses. */
  readonly routes: readonly RouteEntry[];
  /**
   * Everything `Bun.serve` needs but the address, so production and test
   * servers share one connection policy. `routes` holds one handler per path
   * and dispatches methods; `fetch` answers paths no route serves.
   */
  readonly serveOptions: {
    readonly routes: Readonly<Record<string, BunRouteHandler>>;
    readonly fetch: (request: Request, server: HttpServer) => Promise<Response>;
    readonly idleTimeout: number;
  };
};

export const createHttpApp = ({
  routes,
  middleware,
}: HttpAppOptions): HttpApp => {
  const index = indexRoutes(routes);

  const routeChains = new Map<RouteEntry, Next>(
    routes.map((entry) => [
      entry,
      chain(entry.middleware, async (inner) => {
        const answer = await entry.definition.run({
          ctx: inner,
          route: entry.path,
          readBody: async () =>
            await readBody(
              inner.request,
              entry.definition.config.bodyMode ?? "auto",
            ),
        });
        return toResponse(await encodeAnswer(entry, answer, inner), inner.set);
      }),
    ]),
  );

  const pipeline = chain(middleware, async (inner) => {
    const matched =
      inner.route === undefined ? undefined : index.get(inner.route);
    if (matched === undefined) {
      throw new HttpFailureError(HTTP_FAILURE.notFound);
    }
    const routeChain =
      inner.routeEntry === undefined
        ? undefined
        : routeChains.get(inner.routeEntry);
    if (routeChain === undefined) {
      throw new HttpFailureError(HTTP_FAILURE.methodNotAllowed, {
        allow: [...matched.byMethod.keys()],
      });
    }
    return await routeChain(inner);
  });

  const handle = async (
    request: Request,
    server: HttpServer,
    matched: PathRoutes | undefined,
    params: Readonly<Record<string, string>>,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const routeEntry = entryFor(matched, request.method);
    // Read on first use: most answers (a preflight, a refusal, a route with
    // no query) never look at it.
    let query: QueryRecord | undefined;
    const ctx: RequestContext = {
      request,
      server,
      path: url.pathname,
      route: matched?.pattern,
      routeEntry,
      params,
      get query() {
        query ??= parseQuery(url);
        return query;
      },
      set: createResponseSet(),
    };
    const response = await pipeline(ctx);
    return request.method === "HEAD" ? withoutBody(response) : response;
  };

  const bunRoutes = Object.fromEntries(
    [...index].flatMap(([pattern, pathRoutes]) => {
      const handler: BunRouteHandler = async (request, server) => {
        // A route request is a `Request` at run time. bun-types declares its
        // `clone()` apart from the web one, so a guard (not `instanceof`,
        // which trusts the declared heritage) narrows it to what the
        // pipeline reads.
        if (!isWebRequest(request)) {
          return panic("Bun.serve handed a route a non-Request value");
        }
        return await handle(request, server, pathRoutes, request.params);
      };
      const mounts: [string, BunRouteHandler][] = [[pattern, handler]];
      // A trailing slash names the same resource.
      const slashed = `${pattern}/`;
      if (
        pattern !== "/" &&
        !pattern.endsWith("/") &&
        !pattern.endsWith("*") &&
        !index.has(slashed)
      ) {
        mounts.push([slashed, handler]);
      }
      return mounts;
    }),
  );

  return {
    routes,
    serveOptions: {
      routes: bunRoutes,
      fetch: async (request, server) =>
        await handle(request, server, undefined, {}),
      idleTimeout: HTTP_IDLE_TIMEOUT_S,
    },
  };
};
