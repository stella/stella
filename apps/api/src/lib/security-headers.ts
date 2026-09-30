import type { Context } from "elysia";

import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/cache-policy";

const SECURITY_HEADERS = {
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
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
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
