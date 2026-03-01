import type { Context } from "elysia";

const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-DNS-Prefetch-Control": "off",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

export const setSecurityHeaders = (set: Context["set"]) => {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    set.headers[key] = value;
  }
};
