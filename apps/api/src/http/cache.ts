import { panic } from "better-result";

import { setResponseHeaders } from "@/api/http/headers";
import type { Middleware } from "@/api/http/route";

export const CACHE_CONTROL_HEADER = "Cache-Control";
export const PRIVATE_CACHE_CONTROL = "private, no-store";
export const SSE_CACHE_CONTROL = "private, no-cache, no-store, no-transform";
export const SSE_MEDIA_TYPE = "text/event-stream";
export const PRAGMA_NO_CACHE = "no-cache";
export const NO_STORE_DIRECTIVE = "no-store";

/** How long a successful answer may be kept, and by whom. */
export type CachePolicy =
  | { readonly kind: "none" }
  | { readonly kind: "private"; readonly maxAge: number }
  | { readonly kind: "public"; readonly maxAge: number; readonly swr?: number };

export const NO_CACHE: CachePolicy = { kind: "none" };

export const publicCacheControl = (
  cache: Extract<CachePolicy, { kind: "public" }>,
): string =>
  `public, max-age=${cache.maxAge}${cache.swr === undefined ? "" : `, stale-while-revalidate=${cache.swr}`}`;

const directiveFor = (cache: CachePolicy): string => {
  switch (cache.kind) {
    case "public":
      return publicCacheControl(cache);
    case "private":
      return `private, max-age=${cache.maxAge}`;
    case "none":
      return PRIVATE_CACHE_CONTROL;
    default: {
      cache satisfies never;
      return panic("Unhandled response cache policy");
    }
  }
};

/**
 * The `Cache-Control` a final answer is sent with. Only a successful answer
 * that sets no cookie and was not marked private may be kept; an event stream
 * is never kept and never transformed.
 */
export const cacheControlFor = (
  response: Response,
  {
    cache,
    privateOnly,
  }: { readonly cache: CachePolicy; readonly privateOnly: boolean },
): string => {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType === SSE_MEDIA_TYPE) {
    return SSE_CACHE_CONTROL;
  }
  const cacheable =
    !privateOnly &&
    !response.headers.has("set-cookie") &&
    response.status >= 200 &&
    response.status < 300;
  return cacheable ? directiveFor(cache) : PRIVATE_CACHE_CONTROL;
};

/**
 * Decides every answer's `Cache-Control` once, on the final response: the
 * policy a handler chose at run time, else its route's declared policy, else
 * none. Runs outside every stage that can still change the status.
 */
export const responseCachePolicy: Middleware = async (ctx, inner) => {
  const response = await inner();
  return setResponseHeaders(
    response,
    {
      [CACHE_CONTROL_HEADER]: cacheControlFor(response, {
        cache: ctx.set.cache ?? ctx.routeEntry?.definition.cache ?? NO_CACHE,
        privateOnly: ctx.set.privateOnly === true,
      }),
    },
    { overwrite: true },
  );
};
