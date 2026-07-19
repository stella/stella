import type { Context } from "elysia";

const SECURITY_HEADERS = {
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
  // Raw file/PDF `Response`s bypass `set.headers` and carry their own policy
  // via RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS.
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
 * bytes, PDF/DOCX downloads). Those responses bypass Elysia's `set.headers`,
 * so the global `setSecurityHeaders` never reaches them: a stored document
 * would otherwise be served without nosniff/frame/CSP protection and could be
 * MIME-sniffed (e.g. a `text/html` upload rendered inline) or framed. Every
 * raw document `Response` must spread these into its headers so that class of
 * gap cannot recur per-endpoint.
 */
export const RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; object-src 'none'; base-uri 'none'",
} as const;
