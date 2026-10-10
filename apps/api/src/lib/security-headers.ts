import type { Context } from "elysia";

import {
  CHAT_TURN_ID_HEADER,
  CLAUSE_WARNINGS_HEADER,
  REQUEST_ID_HEADER,
  UNDECIDED_CONDITIONS_HEADER,
} from "@stll/api-contract";

import {
  normalizeResponseStatus,
  resolveResponseStatus,
} from "@/api/lib/observability/response-status";

export const CORS_EXPOSED_HEADERS = [
  "Content-Disposition",
  "X-Ai-Field-Errors",
  CLAUSE_WARNINGS_HEADER,
  UNDECIDED_CONDITIONS_HEADER,
  REQUEST_ID_HEADER,
  CHAT_TURN_ID_HEADER,
];

export const CACHE_CONTROL_HEADER = "Cache-Control";
export const PRIVATE_CACHE_CONTROL = "private, no-store";

/**
 * Headers every frame document the web app embeds must send. The web app
 * is cross-origin isolated (COEP credentialless), so the browser refuses a
 * cross-origin frame unless it opts into the same embedder policy and
 * allows cross-origin embedding.
 */
export const EMBEDDABLE_FRAME_HEADERS = {
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "cross-origin",
} as const;
export const SSE_CACHE_CONTROL = "private, no-cache, no-store, no-transform";
export const SSE_MEDIA_TYPE = "text/event-stream";
export const PRAGMA_NO_CACHE = "no-cache";
export const NO_STORE_DIRECTIVE = "no-store";

export type CachePolicy =
  | { kind: "none" }
  | { kind: "public"; maxAge: number; swr?: number };

export const publicCacheControl = (
  cache: Extract<CachePolicy, { kind: "public" }>,
) =>
  `public, max-age=${cache.maxAge}${cache.swr === undefined ? "" : `, stale-while-revalidate=${cache.swr}`}`;

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
      : Object.entries(set.headers)
          .find(([key]) => key.toLowerCase() === "content-type")?.[1]
          ?.toString();
  const isEventStream =
    contentType?.split(";").at(0)?.trim().toLowerCase() === SSE_MEDIA_TYPE;
  const setsCookie =
    (response instanceof Response && response.headers.has("set-cookie")) ||
    (set.headers instanceof Headers
      ? set.headers.has("set-cookie")
      : Object.entries(set.headers).some(
          ([name, value]) =>
            name.toLowerCase() === "set-cookie" &&
            (Array.isArray(value) ? value.length > 0 : Boolean(value)),
        )) ||
    Object.keys(set.cookie ?? {}).length > 0;
  const cacheControl =
    cache.kind === "public" &&
    !setsCookie &&
    !privateResponses.has(set) &&
    status >= 200 &&
    status < 300
      ? publicCacheControl(cache)
      : PRIVATE_CACHE_CONTROL;
  const value = isEventStream ? SSE_CACHE_CONTROL : cacheControl;

  // Record initializers append differently-cased names, unlike Headers.set().
  for (const key of Object.keys(set.headers)) {
    if (key.toLowerCase() === CACHE_CONTROL_HEADER.toLowerCase()) {
      Reflect.deleteProperty(set.headers, key);
    }
  }
  set.headers[CACHE_CONTROL_HEADER] = value;

  return value;
};

type FinalizeResponseCachePolicyOptions = {
  response: unknown;
  set: Context["set"];
};

/** Recheck the final status after route hooks, including early/error replies. */
export const finalizeResponseCachePolicy = ({
  response,
  set,
}: FinalizeResponseCachePolicyOptions) => {
  const output = normalizeResponseStatus({ response, set });
  const value = applyResponseCachePolicy({
    cache: requestPolicies.get(set) ?? { kind: "none" },
    response: output ?? response,
    set,
  });
  if (output instanceof Response) {
    output.headers.set(CACHE_CONTROL_HEADER, value);
  }
  return output;
};

export const API_SECURITY_HEADERS = {
  [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL,
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-DNS-Prefetch-Control": "off",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // This API serves JSON and 302 redirects only — the /auth and /consent
  // surfaces redirect to the frontend, so no Elysia-managed response is an
  // HTML document that loads scripts/styles. A locked-down policy is therefore
  // safe here and gives defense-in-depth against any response ever being
  // interpreted as an active document (e.g. a reflected value rendered inline).
  // Raw document responses carry the stricter document policy below;
  // Elysia merges global headers when the response has no override.
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
} as const;

export const setSecurityHeaders = (set: Context["set"]) => {
  for (const [key, value] of Object.entries(API_SECURITY_HEADERS)) {
    set.headers[key] = value;
  }
};

/**
 * Security headers for handlers that return a raw `Response` (streamed file
 * bytes, PDF/DOCX downloads). Elysia merges missing global headers, but
 * document-specific policies must override those defaults. A document could be
 * MIME-sniffed (e.g. a `text/html` upload rendered inline) or framed. Raw
 * document responses must use `secureDocumentResponse`, which applies this
 * policy by construction. Sensitive document bytes must also remain out of
 * browser and intermediary caches.
 */
export const RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS = {
  [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; object-src 'none'; base-uri 'none'",
} as const;
