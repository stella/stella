import type { Context } from "elysia";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { resolveResponseStatus } from "@/api/lib/observability/response-status";

export const CACHE_CONTROL_HEADER = "Cache-Control";
export const PRIVATE_CACHE_CONTROL = "private, no-store";
export const SSE_CACHE_CONTROL = "private, no-cache, no-store, no-transform";
export const SSE_MEDIA_TYPE = "text/event-stream";
export const PRAGMA_NO_CACHE = "no-cache";

export type CachePolicy =
  | { kind: "none" }
  | { kind: "public"; maxAge: number; swr?: number };

const requestPolicies = new WeakMap<Context["set"], CachePolicy>();
const privateResponses = new WeakSet<Context["set"]>();

/** A successful fallback is not the public representation a caller requested. */
export const preventPublicCaching = (set: Context["set"]) => {
  privateResponses.add(set);
};

type ApplyResponseCachePolicyOptions = {
  cache: CachePolicy;
  response: unknown;
  set: Context["set"];
};

export const applyResponseCachePolicy = ({
  cache,
  response,
  set,
}: ApplyResponseCachePolicyOptions) => {
  requestPolicies.set(set, cache);
  const status = resolveResponseStatus({ response, set });
  const contentType =
    response instanceof Response
      ? response.headers.get("content-type")
      : new Headers(set.headers).get("content-type");
  const isEventStream =
    contentType?.split(";").at(0)?.trim().toLowerCase() === SSE_MEDIA_TYPE;
  const cacheControl =
    cache.kind === "public" &&
    !privateResponses.has(set) &&
    status >= 200 &&
    status < 300
      ? `public, max-age=${cache.maxAge}${cache.swr === undefined ? "" : `, stale-while-revalidate=${cache.swr}`}`
      : PRIVATE_CACHE_CONTROL;
  const value = isEventStream ? SSE_CACHE_CONTROL : cacheControl;

  // Record initializers append differently-cased names, unlike Headers.set().
  set.headers = Object.fromEntries(
    Object.entries(set.headers).filter(
      ([key]) => key.toLowerCase() !== CACHE_CONTROL_HEADER.toLowerCase(),
    ),
  );
  set.headers[CACHE_CONTROL_HEADER] = value;

  return value;
};

type FinalizeResponseCachePolicyOptions<T> = {
  response: T;
  set: Context["set"];
};

/** Recheck the final status after route hooks, including early/error replies. */
export const finalizeResponseCachePolicy = <T>({
  response,
  set,
}: FinalizeResponseCachePolicyOptions<T>) => {
  // Elysia can wrap a raw Response in status(...); normalize that branch too.
  let raw: unknown = response;
  while (raw instanceof ElysiaCustomStatusResponse) {
    raw = raw.response;
  }
  const output =
    raw instanceof Response
      ? new Response(raw.body, {
          headers: raw.headers,
          status: resolveResponseStatus({ response, set }),
          statusText: raw.statusText,
        })
      : response;
  const value = applyResponseCachePolicy({
    cache: requestPolicies.get(set) ?? { kind: "none" },
    response: output,
    set,
  });
  if (output instanceof Response) {
    output.headers.set(CACHE_CONTROL_HEADER, value);
  }
  return output;
};
