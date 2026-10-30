import { panic } from "better-result";

import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import { DAY_IN_MS } from "@stll/time";

import { recordLegalResolveAudit } from "@/api/db/root";
import {
  authorizeLegalResolveRequest,
  authorizeLegalResolveRequestOnce,
  authorizeOncePerRequest,
  type LegalResolveAuthorizationDependencies,
} from "@/api/handlers/legal-resolve/authorization";
import { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import { createLegalResolveDecisionHandler } from "@/api/handlers/legal-resolve/decision-endpoint";
import { resolveLawCitation } from "@/api/handlers/legal-resolve/law";
import { createLegalResolveLawHandler } from "@/api/handlers/legal-resolve/law-endpoint";
import type {
  GetLegalResolveAuthorization,
  LegalResolveResolved,
} from "@/api/handlers/legal-resolve/route-handler";
import {
  serviceResolveAuditCountry,
  serviceResolveAuditOutcome,
} from "@/api/handlers/legal-resolve/service-audit";
import type { RequestContext } from "@/api/http/context";
import { HTTP_FAILURE, isHttpFailure } from "@/api/http/errors";
import { setResponseHeaders } from "@/api/http/headers";
import { mount, routes } from "@/api/http/route";
import type { Middleware } from "@/api/http/route";
import { isServiceResolveSession } from "@/api/lib/db/service-client-contract";
import type { LegalResolveSession } from "@/api/lib/db/service-client-contract";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import type {
  RateLimitContext,
  RateLimitOptions,
} from "@/api/lib/rate-limit/contracts";
import { rateLimit, scopedRateLimitKey } from "@/api/lib/rate-limit/rate-limit";
import {
  createRedisRateLimit,
  createRedisRateLimitRequestKey,
} from "@/api/lib/rate-limit/redis-context";
import { getMcpWwwAuthenticateHeader } from "@/api/mcp/metadata";
import { LEGAL_RESOLVE_RESOURCE_ROUTES } from "@/api/mcp/resource-policy-contract";

import type { authenticateLegalResolveToken } from "./authentication";

const credentialKey = (credential: LegalResolveSession): string => {
  if (isServiceResolveSession(credential)) {
    return credential.clientId;
  }
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

export const createLegalResolveRateLimitOptions = (
  route: "decision" | "law",
  getAuthorization: GetLegalResolveAuthorization,
) => ({
  ...API_RATE_LIMITS.legalResolve,
  ...createRedisRateLimit({
    failurePolicy: "fail_closed",
    scope: `legal-resolve-${route}`,
    counterKeyGenerator: async (request, server) => {
      const authorization = await getAuthorization(request);
      if (authorization.session === undefined) {
        return scopedRateLimitKey({
          scope: `unauthorized:${route}`,
          request,
          server,
        });
      }
      return `${authorization.session.organizationId}:${credentialKey(authorization.session)}:${route}`;
    },
  }),
  max: async (request: Request) => {
    const authorization = await getAuthorization(request);
    return authorization.session !== undefined &&
      isServiceResolveSession(authorization.session)
      ? authorization.session.requestsPerMinute
      : API_RATE_LIMITS.legalResolve.max;
  },
  additionalBudgets: async (request: Request) => {
    const authorization = await getAuthorization(request);
    if (
      authorization.session !== undefined &&
      isServiceResolveSession(authorization.session)
    ) {
      return [
        {
          key: createRedisRateLimitRequestKey({
            counterKey: `${authorization.session.organizationId}:${authorization.session.clientId}:legal-resolve-daily`,
            requestId: Bun.randomUUIDv7(),
          }),
          max: authorization.session.dailyBudget,
          duration: DAY_IN_MS,
        },
      ];
    }
    return [];
  },
});

type LegalResolveRouteDependencies = {
  authenticate?: typeof authenticateLegalResolveToken;
  recordAudit?: typeof recordLegalResolveAudit;
  decisionRateLimit?: RateLimitOptions;
  lawRateLimit?: RateLimitOptions;
  rateLimitContext?: RateLimitContext;
  publicLawEnabled?: () => boolean;
  resolveSessionContext?: LegalResolveAuthorizationDependencies["resolveSessionContext"];
  resolveDecision?: typeof resolveDecision;
  resolveLaw?: typeof resolveLawCitation;
};

export const createLegalResolveRoute = ({
  authenticate,
  recordAudit = recordLegalResolveAudit,
  decisionRateLimit,
  lawRateLimit,
  rateLimitContext,
  publicLawEnabled,
  resolveSessionContext,
  resolveDecision: resolveDecisionRequest = resolveDecision,
  resolveLaw = resolveLawCitation,
}: LegalResolveRouteDependencies = {}) => {
  const isPublicLawEnabled =
    publicLawEnabled ??
    (() => isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"));
  const auditedRequests = new WeakSet<Request>();
  const resolvedResponses = new WeakMap<Request, LegalResolveResponse>();
  const onResolved: LegalResolveResolved = (request, response) => {
    resolvedResponses.set(request, response);
  };
  const usesDefaultAuthorization =
    authenticate === undefined &&
    publicLawEnabled === undefined &&
    resolveSessionContext === undefined;
  const getAuthorization = usesDefaultAuthorization
    ? authorizeLegalResolveRequestOnce
    : authorizeOncePerRequest(
        async (request) =>
          await authorizeLegalResolveRequest(request, {
            ...(authenticate === undefined ? {} : { authenticate }),
            publicLawEnabled: isPublicLawEnabled,
            ...(resolveSessionContext === undefined
              ? {}
              : { resolveSessionContext }),
          }),
      );
  const decisionHandler = createLegalResolveDecisionHandler({
    getAuthorization,
    resolve: resolveDecisionRequest,
    onResolved,
  });
  const lawHandler = createLegalResolveLawHandler({
    getAuthorization,
    resolve: resolveLaw,
    onResolved,
  });

  /**
   * Audits each answered call of a verified caller once, by the outcome its
   * status and resolved envelope show; never the query or the document.
   */
  const auditAnswer = async (ctx: RequestContext, status: number) => {
    const { request } = ctx;
    if (auditedRequests.has(request)) {
      return;
    }
    const authorization =
      await getAuthorization.getExistingAuthorization(request);
    if (authorization?.session === undefined) {
      return;
    }
    auditedRequests.add(request);
    await recordAudit({
      principal: authorization.session,
      credentialKey: credentialKey(authorization.session),
      route: ctx.path.includes("/case/") ? "case" : "law",
      country: serviceResolveAuditCountry(ctx.params["country"] ?? ""),
      outcome: serviceResolveAuditOutcome(
        resolvedResponses.get(request),
        status,
      ),
    });
  };

  const legalResolveAnswer: Middleware = async (ctx, inner) => {
    try {
      const response = await inner();
      await auditAnswer(ctx, response.status);
      return response.status === 401
        ? setResponseHeaders(
            response,
            {
              "WWW-Authenticate": getMcpWwwAuthenticateHeader({
                error: ctx.request.headers.has("authorization")
                  ? "invalid_token"
                  : "none",
                mode: "law",
              }),
            },
            { overwrite: true },
          )
        : response;
    } catch (error) {
      // A verified caller's rejected input or a faulty answer is still an
      // outcome of its call.
      if (isHttpFailure(error) && error.kind === HTTP_FAILURE.invalidRequest) {
        await auditAnswer(ctx, 422);
      }
      if (isHttpFailure(error) && error.kind === HTTP_FAILURE.invalidResponse) {
        await auditAnswer(ctx, 500);
      }
      throw error;
    }
  };

  return mount(
    [
      routes(
        {
          [LEGAL_RESOLVE_RESOURCE_ROUTES.decision.path]: {
            GET: decisionHandler,
          },
        },
        {
          middleware: [
            rateLimit(
              decisionRateLimit ?? {
                ...createLegalResolveRateLimitOptions(
                  "decision",
                  getAuthorization,
                ),
                ...(rateLimitContext === undefined
                  ? {}
                  : { context: rateLimitContext }),
              },
            ),
          ],
        },
      ),
      routes(
        { [LEGAL_RESOLVE_RESOURCE_ROUTES.law.path]: { GET: lawHandler } },
        {
          middleware: [
            rateLimit(
              lawRateLimit ?? {
                ...createLegalResolveRateLimitOptions("law", getAuthorization),
                ...(rateLimitContext === undefined
                  ? {}
                  : { context: rateLimitContext }),
              },
            ),
          ],
        },
      ),
    ],
    {
      // The audit sees every answer, the feature gate's included; the gate
      // runs before the limiter so a disabled deployment spends no budget.
      middleware: [
        legalResolveAnswer,
        deploymentFeatureGate("FEATURE_PUBLIC_LAW", {
          isEnabled: isPublicLawEnabled,
        }),
      ],
    },
  );
};

export const legalResolveRoute = createLegalResolveRoute();
