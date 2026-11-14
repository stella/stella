import type { Middleware } from "@/api/http/route";

export type CorsPolicy = {
  /** Origins allowed to read credentialed answers. */
  readonly isAllowedOrigin: (origin: string) => boolean;
  readonly methods: readonly string[];
  readonly allowedHeaders: readonly string[];
  readonly exposedHeaders: readonly string[];
  readonly maxAgeSeconds: number;
};

const appendVary = (headers: Headers, ...fields: readonly string[]): void => {
  const vary = headers.get("vary");
  if (vary === null) {
    headers.set("vary", fields.join(", "));
    return;
  }
  const present = new Set(
    vary
      .split(",")
      .map((field) => field.trim().toLowerCase())
      .filter((field) => field !== ""),
  );
  for (const field of fields) {
    if (!present.has(field.toLowerCase())) {
      headers.append("vary", field);
      present.add(field.toLowerCase());
    }
  }
};

const isPreflight = (request: Request): boolean =>
  request.method === "OPTIONS" &&
  request.headers.has("access-control-request-method");

/**
 * Credentialed CORS for browser callers on an allowed origin. A preflight is
 * answered here for any path; a route that owns its CORS (the MCP transports,
 * which answer any origin without credentials) is passed through untouched.
 */
export const cors = (policy: CorsPolicy): Middleware => {
  const allowMethods = policy.methods.join(", ");
  const allowHeaders = policy.allowedHeaders.join(", ");
  const exposedHeaders = policy.exposedHeaders.join(", ");
  // A preflight's answer is the same for every allowed origin but the origin
  // itself, so its headers are built once.
  const preflightVary =
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";
  const allowedPreflight: [string, string][] = [
    ["vary", preflightVary],
    ["access-control-allow-credentials", "true"],
    ["access-control-allow-methods", allowMethods],
    ["access-control-allow-headers", allowHeaders],
    ["access-control-max-age", String(policy.maxAgeSeconds)],
  ];
  return async (ctx, inner) => {
    if (ctx.routeEntry?.definition.cors === "own") {
      return await inner();
    }
    const origin = ctx.request.headers.get("origin");
    const allowed = origin !== null && policy.isAllowedOrigin(origin);

    if (isPreflight(ctx.request)) {
      return new Response(null, {
        status: 204,
        headers: allowed
          ? [...allowedPreflight, ["access-control-allow-origin", origin]]
          : [["vary", preflightVary]],
      });
    }

    // Edited in place, as every stage edits its answer (see
    // `setResponseHeaders`).
    const response = await inner();
    const { headers } = response;
    appendVary(headers, "Origin");
    if (allowed) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-credentials", "true");
      headers.set("access-control-expose-headers", exposedHeaders);
    }
    return response;
  };
};
