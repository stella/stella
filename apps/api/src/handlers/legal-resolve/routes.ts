import { panic } from "better-result";
import Elysia, { t } from "elysia";

import {
  authorizeLegalResolveRequest,
  type LegalResolveAuthorizationDependencies,
} from "@/api/handlers/legal-resolve/authorization";
import { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import { resolveLawCitation } from "@/api/handlers/legal-resolve/law";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  rateLimit,
  type RateLimitOptions,
} from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";
import type { authenticateMcpRequest, McpSession } from "@/api/mcp/auth";

const response = {
  200: t.Any(),
  403: t.Object({
    error: t.Union([t.Literal("missing_scope"), t.Literal("not_entitled")]),
  }),
  429: t.String(),
  503: t.Object({ error: t.Literal("access_unavailable") }),
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

type LegalResolveAuthorization = Awaited<
  ReturnType<typeof authorizeLegalResolveRequest>
>;

type GetAuthorization = (
  request: Request,
) => Promise<LegalResolveAuthorization>;

const createLegalResolveRateLimitOptions = (
  route: "decision" | "law",
  getAuthorization: GetAuthorization,
) => ({
  ...API_RATE_LIMITS.legalResolve,
  ...createRedisRateLimit({
    failurePolicy: "fail_open_local",
    scope: `legal-resolve-${route}`,
    counterKeyGenerator: async (request) => {
      const authorization = await getAuthorization(request);
      if (authorization.status !== 200) {
        return `unauthorized:${route}`;
      }
      return `${authorization.session.organizationId}:${credentialKey(authorization.session)}:${route}`;
    },
  }),
});

type LegalResolveRouteDependencies = {
  authenticate?: typeof authenticateMcpRequest;
  decisionRateLimit?: RateLimitOptions;
  lawRateLimit?: RateLimitOptions;
  mayReadPublicLaw?: LegalResolveAuthorizationDependencies["mayReadPublicLaw"];
  publicLawEnabled?: () => boolean;
  resolveDecision?: typeof resolveDecision;
  resolveLaw?: typeof resolveLawCitation;
};

export const createLegalResolveRoute = ({
  authenticate,
  decisionRateLimit,
  lawRateLimit,
  mayReadPublicLaw,
  publicLawEnabled,
  resolveDecision: resolveDecisionRequest = resolveDecision,
  resolveLaw = resolveLawCitation,
}: LegalResolveRouteDependencies = {}) => {
  const authorizationByRequest = new WeakMap<
    Request,
    Promise<LegalResolveAuthorization>
  >();
  const getAuthorization = async (request: Request) => {
    const existing = authorizationByRequest.get(request);
    if (existing !== undefined) {
      return await existing;
    }
    const authorization = authorizeLegalResolveRequest(request, {
      ...(authenticate === undefined ? {} : { authenticate }),
      ...(publicLawEnabled === undefined ? {} : { publicLawEnabled }),
      ...(mayReadPublicLaw === undefined ? {} : { mayReadPublicLaw }),
    });
    authorizationByRequest.set(request, authorization);
    return await authorization;
  };
  const authorizationContext = new Elysia().derive(
    { as: "scoped" },
    async ({ request }) => ({
      legalResolveAuthorization: await getAuthorization(request),
    }),
  );
  const requireLawRead = ({
    legalResolveAuthorization,
    set,
  }: {
    legalResolveAuthorization: LegalResolveAuthorization;
    set: { status?: number | string };
  }) => {
    if (
      legalResolveAuthorization.status === 403 ||
      legalResolveAuthorization.status === 503
    ) {
      set.status = legalResolveAuthorization.status;
      return legalResolveAuthorization.body;
    }
    return undefined;
  };

  return new Elysia()
    .mapResponse(({ set }) => {
      set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
    })
    .use(authorizationContext)
    .group("", (app) =>
      app
        .use(
          rateLimit(
            decisionRateLimit ??
              createLegalResolveRateLimitOptions("decision", getAuthorization),
          ),
        )
        .get(
          "/case/:country/decisions/resolve",
          // oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- protocol bearer-scope boundary; it reads only the public corpus
          async ({ legalResolveAuthorization, params, query }) => {
            if (legalResolveAuthorization.status !== 200) {
              return panic("Legal resolve handler ran without admission");
            }
            return await resolveDecisionRequest({
              admission: legalResolveAuthorization.admission,
              country: params.country,
              identifier: query.identifier,
            });
          },
          {
            beforeHandle: requireLawRead,
            params: t.Object({
              country: t.String({ minLength: 2, maxLength: 3 }),
            }),
            query: t.Object({ identifier: t.String({ maxLength: 512 }) }),
            response,
          },
        ),
    )
    .group("", (app) =>
      app
        .use(
          rateLimit(
            lawRateLimit ??
              createLegalResolveRateLimitOptions("law", getAuthorization),
          ),
        )
        .get(
          "/law/:country/citations/resolve",
          // oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- protocol bearer-scope boundary; it reads only the public corpus
          async ({ legalResolveAuthorization, params, query }) => {
            if (legalResolveAuthorization.status !== 200) {
              return panic("Legal resolve handler ran without admission");
            }
            return await resolveLaw({
              admission: legalResolveAuthorization.admission,
              country: params.country,
              input: query,
            });
          },
          {
            beforeHandle: requireLawRead,
            params: t.Object({
              country: t.String({ minLength: 2, maxLength: 3 }),
            }),
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
        ),
    );
};

export const legalResolveRoute = createLegalResolveRoute();
