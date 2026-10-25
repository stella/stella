import {
  CHAT_TURN_ID_HEADER,
  CLAUSE_WARNINGS_HEADER,
  REQUEST_ID_HEADER,
  UNDECIDED_CONDITIONS_HEADER,
} from "@stll/api-contract";

import type { CachePolicy } from "@/api/http/cache";
import { CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL } from "@/api/http/cache";
import { setResponseHeaders } from "@/api/http/headers";
import type { Middleware } from "@/api/http/route";

export const CORS_EXPOSED_HEADERS = [
  "Content-Disposition",
  "X-Ai-Field-Errors",
  CLAUSE_WARNINGS_HEADER,
  UNDECIDED_CONDITIONS_HEADER,
  REQUEST_ID_HEADER,
  CHAT_TURN_ID_HEADER,
  "x-db-transactions",
];

export const DISCOVERY_METADATA_CACHE_POLICY = {
  kind: "public",
  maxAge: 300,
  swr: 3600,
} as const satisfies CachePolicy;

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

export const API_SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-DNS-Prefetch-Control": "off",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // This API serves JSON and 302 redirects only: the /auth and /consent
  // surfaces redirect to the frontend, so no API answer is an HTML document
  // that loads scripts or styles. A locked-down policy is therefore safe here
  // and gives defense in depth against any response ever being interpreted as
  // an active document (a reflected value rendered inline). Raw document
  // responses carry the stricter document policy below, which wins.
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
} as const;

/** Whether a response states its own framing policy (`frame-ancestors`). */
const ownsFramingPolicy = (response: Response): boolean =>
  response.headers
    .get("content-security-policy")
    ?.toLowerCase()
    .includes("frame-ancestors") === true;

/**
 * Every answer leaves with the API security headers. A response that sets
 * one of them itself (a raw document) keeps its own, and a response whose
 * Content-Security-Policy names its `frame-ancestors` (an embeddable sandbox
 * document) gets no `X-Frame-Options`: the CSP directive is the framing
 * policy browsers enforce. Applied to the final response, so answers built by
 * any stage, refusals and errors included, carry them.
 */
const { "X-Frame-Options": _frameOptions, ...FRAMING_NEUTRAL_HEADERS } =
  API_SECURITY_HEADERS;

export const securityHeaders: Middleware = async (_ctx, inner) => {
  const response = await inner();
  return setResponseHeaders(
    response,
    ownsFramingPolicy(response)
      ? FRAMING_NEUTRAL_HEADERS
      : API_SECURITY_HEADERS,
    { overwrite: false },
  );
};

/**
 * Security headers for handlers that return a raw `Response` (streamed file
 * bytes, PDF/DOCX downloads). The API defaults fill only what a response
 * leaves unset, so document-specific policies override them. A document could
 * be MIME-sniffed (a `text/html` upload rendered inline) or framed. Raw
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
