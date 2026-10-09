import { panic } from "better-result";
import Elysia, { t } from "elysia";

import { authorizeLegalResolveRequest } from "@/api/handlers/legal-resolve/authorization";
import { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import { resolveLawCitation } from "@/api/handlers/legal-resolve/law";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";
import type { McpSession } from "@/api/mcp/auth";

const response = {
  200: t.Any(),
  403: t.Object({ error: t.Literal("missing_scope") }),
  429: t.String(),
};

const credentialKey = (credential: McpSession): string => {
  const value = credential.credential;
  if (value === undefined || value.type === "delegated_user") {
    return credential.userId;
  }
  switch (value.type) {
    case "oauth_client":
      return value.clientId;
    case "agent_run":
      return value.runId;
    case "machine_api_key":
    case "personal_api_key":
      return value.id;
    default:
      value satisfies never;
      return panic("Unknown legal resolve credential type");
  }
};

export const createLegalResolveRateLimitOptions = (route: "decision" | "law") =>
  ({
    ...API_RATE_LIMITS.legalResolve,
    ...createRedisRateLimit({
      failurePolicy: "fail_open_local",
      scope: `legal-resolve-${route}`,
      counterKeyGenerator: async (request) => {
        const authorization = await authorizeLegalResolveRequest(request);
        if (authorization.status === 403) {
          return `unauthorized:${route}`;
        }
        return `${authorization.session.organizationId}:${credentialKey(authorization.session)}:${route}`;
      },
    }),
    skip: (request: Request) =>
      route === "decision"
        ? !new URL(request.url).pathname.endsWith("/decisions/resolve")
        : !new URL(request.url).pathname.endsWith("/citations/resolve"),
  }) as const;

const withLawRead = async (
  request: Request,
  set: { status?: number | string },
) => {
  const authorization = await authorizeLegalResolveRequest(request);
  if (authorization.status === 403) {
    set.status = 403;
    return authorization.body;
  }
  return undefined;
};

export const legalResolveRoute = new Elysia()
  .mapResponse(({ set }) => {
    set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
  })
  .use(rateLimit(createLegalResolveRateLimitOptions("decision")))
  .get(
    "/case/:country/decisions/resolve",
    // oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- protocol bearer-scope boundary; it reads only the public corpus
    async ({ params, query }) =>
      await resolveDecision(params.country, query.identifier),
    {
      beforeHandle: async ({ request, set }) => await withLawRead(request, set),
      params: t.Object({ country: t.String({ minLength: 2, maxLength: 3 }) }),
      query: t.Object({ identifier: t.String({ maxLength: 512 }) }),
      response,
    },
  )
  .use(rateLimit(createLegalResolveRateLimitOptions("law")))
  .get(
    "/law/:country/citations/resolve",
    // oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- protocol bearer-scope boundary; it reads only the public corpus
    async ({ params, query }) =>
      await resolveLawCitation(params.country, query),
    {
      beforeHandle: async ({ request, set }) => await withLawRead(request, set),
      params: t.Object({ country: t.String({ minLength: 2, maxLength: 3 }) }),
      query: t.Object({
        citation: t.Optional(t.String({ maxLength: 512 })),
        collection: t.Optional(t.String({ maxLength: 32 })),
        year: t.Optional(t.String({ maxLength: 4 })),
        number: t.Optional(t.String({ maxLength: 16 })),
        section: t.Optional(t.String({ maxLength: 32 })),
        asOf: t.Optional(t.String({ format: "date" })),
      }),
      response,
    },
  );
