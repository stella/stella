import type { Server } from "bun";

import type { CachePolicy } from "@/api/http/cache";
import type { QueryRecord } from "@/api/http/input";
import type { RouteEntry } from "@/api/http/route";
import type { status } from "@/api/http/status";
import type { ApiSocketData } from "@/api/http/websocket";

/** Response headers a request accumulates before its answer is built. */
export type ResponseHeaders = Record<string, string | string[]>;

/** The mutable status, headers and cache decision of the answer being built. */
export type ResponseSet = {
  status?: number;
  headers: ResponseHeaders;
  /** A cache policy the handler chose at run time, over its route's declared one. */
  cache?: CachePolicy;
  /** Never cache this answer publicly, whatever the policy (a fallback answer). */
  privateOnly?: boolean;
};

/** The server a request arrived on; an upgraded socket carries its session. */
export type HttpServer = Server<ApiSocketData>;

/** What every stage of the pipeline sees about the request in flight. */
export type RequestContext = {
  readonly request: Request;
  readonly server: HttpServer | null;
  /** The request path, without the query string. */
  readonly path: string;
  /** The matched route pattern (`/v1/files/:fileId`), absent when none matched. */
  readonly route: string | undefined;
  /** The route serving this method on the matched path, if any. */
  readonly routeEntry: RouteEntry | undefined;
  /** Matched path segments, URL-decoded; empty when no route matched. */
  readonly params: Readonly<Record<string, string>>;
  /** The query string; a key sent more than once is a list. */
  readonly query: QueryRecord;
  readonly set: ResponseSet;
};

/** What a route handler sees: the request plus its decoded, validated input. */
export type HandlerContext<
  TParams = Record<string, string>,
  TQuery = Record<string, string | string[]>,
  TBody = unknown,
  THeaders = Record<string, string>,
> = Omit<RequestContext, "route" | "params" | "query"> & {
  /** The route pattern this handler is mounted at. */
  readonly route: string;
  readonly params: TParams;
  readonly query: TQuery;
  readonly body: TBody;
  /** Request headers, lower-cased; decoded when the route declares a schema. */
  readonly headers: THeaders;
  readonly status: typeof status;
};

export const createResponseSet = (): ResponseSet => ({ headers: {} });

/**
 * The request's headers as a lower-cased record, repeated values joined as
 * `entries()` joins them. Bun's native `toJSON` builds it in one call; only
 * `set-cookie`, which it keeps as a list, is joined here.
 */
export const requestHeaders = (request: Request): Record<string, string> => {
  const headers = request.headers.toJSON();
  const setCookie: readonly string[] | undefined = headers["set-cookie"];
  return setCookie === undefined
    ? headers
    : { ...headers, "set-cookie": setCookie.join(", ") };
};

const isSetCookie = (name: string): boolean =>
  name.length === 10 && name.toLowerCase() === "set-cookie";

/** Copy accumulated headers onto a `Headers`, keeping every `set-cookie`. */
export const applyResponseHeaders = (
  target: Headers,
  source: ResponseHeaders,
  { overwrite }: { overwrite: boolean },
): void => {
  for (const [name, value] of Object.entries(source)) {
    if (isSetCookie(name)) {
      for (const cookie of Array.isArray(value) ? value : [value]) {
        target.append("set-cookie", cookie);
      }
      continue;
    }
    if (!overwrite && target.has(name)) {
      continue;
    }
    target.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
};

/**
 * Append the `set-cookie` values of a `Headers` (a Better Auth answer that
 * refreshed the session) to the headers the request is accumulating.
 */
export const appendSetCookieHeaders = (
  target: ResponseHeaders,
  source: Headers,
): void => {
  const cookies = source.getSetCookie();
  if (cookies.length === 0) {
    return;
  }
  const existing = target["set-cookie"] ?? [];
  target["set-cookie"] = [
    ...(Array.isArray(existing) ? existing : [existing]),
    ...cookies,
  ];
};
