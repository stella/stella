import { panic } from "better-result";
import Elysia from "elysia";

import { DAY_IN_MS } from "@stll/time";

import { recordLegalResolveAudit } from "@/api/db/root";
import {
  authorizeLegalResolveRequest,
  authorizeLegalResolveRequestOnce,
  authorizeOncePerRequest,
  type LegalResolveAuthorizationDependencies,
} from "@/api/handlers/legal-resolve/authorization";
import { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import {
  createLegalResolveDecisionHandler,
  legalResolveDecisionEndpoint,
} from "@/api/handlers/legal-resolve/decision-endpoint";
import { resolveLawCitation } from "@/api/handlers/legal-resolve/law";
import {
  createLegalResolveLawHandler,
  legalResolveLawEndpoint,
} from "@/api/handlers/legal-resolve/law-endpoint";
import type { GetLegalResolveAuthorization } from "@/api/handlers/legal-resolve/route-handler";
import {
  serviceResolveAuditOutcome,
  serviceResolveAuditCountry,
} from "@/api/handlers/legal-resolve/service-audit";
import { isServiceResolveSession } from "@/api/lib/auth/legal-resolve-principal";
import type { LegalResolveSession } from "@/api/lib/auth/legal-resolve-principal";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { resolveResponseStatus } from "@/api/lib/observability/response-status";
import {
  rateLimit,
  type RateLimitContext,
  type RateLimitOptions,
} from "@/api/lib/rate-limit/rate-limit";
import {
  createRedisRateLimitRequestKey,
  createRedisRateLimit,
} from "@/api/lib/rate-limit/redis-context";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";
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
    counterKeyGenerator: async (request) => {
      const authorization = await getAuthorization(request);
      if (authorization.session === undefined) {
        return `unauthorized:${route}`;
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
  mayReadPublicLaw?: LegalResolveAuthorizationDependencies["mayReadPublicLaw"];
  resolveDecision?: typeof resolveDecision;
  resolveLaw?: typeof resolveLawCitation;
};

export const createLegalResolveRoute = ({
  authenticate,
  recordAudit = recordLegalResolveAudit,
  decisionRateLimit,
  lawRateLimit,
  rateLimitContext,
  mayReadPublicLaw,
  publicLawEnabled,
  resolveSessionContext,
  resolveDecision: resolveDecisionRequest = resolveDecision,
  resolveLaw = resolveLawCitation,
}: LegalResolveRouteDependencies = {}) => {
  const isPublicLawEnabled =
    publicLawEnabled ??
    (() => isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"));
  const auditedRequests = new WeakSet<Request>();
  const usesDefaultAuthorization =
    authenticate === undefined &&
    mayReadPublicLaw === undefined &&
    publicLawEnabled === undefined &&
    resolveSessionContext === undefined;
  const getAuthorization = usesDefaultAuthorization
    ? authorizeLegalResolveRequestOnce
    : authorizeOncePerRequest(
        async (request) =>
          await authorizeLegalResolveRequest(request, {
            ...(authenticate === undefined ? {} : { authenticate }),
            publicLawEnabled: isPublicLawEnabled,
            ...(mayReadPublicLaw === undefined ? {} : { mayReadPublicLaw }),
            ...(resolveSessionContext === undefined
              ? {}
              : { resolveSessionContext }),
          }),
      );
  const decisionHandler =
    usesDefaultAuthorization && resolveDecisionRequest === resolveDecision
      ? legalResolveDecisionEndpoint
      : createLegalResolveDecisionHandler({
          getAuthorization,
          resolve: resolveDecisionRequest,
        });
  const lawHandler =
    usesDefaultAuthorization && resolveLaw === resolveLawCitation
      ? legalResolveLawEndpoint
      : createLegalResolveLawHandler({ getAuthorization, resolve: resolveLaw });

  return new Elysia()
    .mapResponse(async ({ set, request, responseValue, params }) => {
      set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
      if (auditedRequests.has(request)) {
        return;
      }
      const pendingAuthorization =
        getAuthorization.getExistingAuthorization(request);
      if (pendingAuthorization === undefined) {
        return;
      }
      const authorization = await pendingAuthorization;
      if (authorization.session === undefined) {
        return;
      }
      auditedRequests.add(request);
      await recordAudit({
        principal: authorization.session,
        credentialKey: credentialKey(authorization.session),
        route: new URL(request.url).pathname.includes("/case/")
          ? "case"
          : "law",
        country: serviceResolveAuditCountry(params["country"] ?? ""),
        outcome: serviceResolveAuditOutcome(
          responseValue,
          resolveResponseStatus({ response: responseValue, set }),
        ),
      });
    })
    .use(
      deploymentFeatureGate(
        () =>
          publicLawEnabled?.() ??
          isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"),
      ),
    )
    .group("", (app) =>
      app
        .use(
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
        )
        .get(
          LEGAL_RESOLVE_RESOURCE_ROUTES.decision.path,
          decisionHandler.handler,
          {
            params: decisionHandler.config.params,
            query: decisionHandler.config.query,
            response: decisionHandler.config.response,
          },
        ),
    )
    .group("", (app) =>
      app
        .use(
          rateLimit(
            lawRateLimit ?? {
              ...createLegalResolveRateLimitOptions("law", getAuthorization),
              ...(rateLimitContext === undefined
                ? {}
                : { context: rateLimitContext }),
            },
          ),
        )
        .get(LEGAL_RESOLVE_RESOURCE_ROUTES.law.path, lawHandler.handler, {
          params: lawHandler.config.params,
          query: lawHandler.config.query,
          response: lawHandler.config.response,
        }),
    );
};

export const legalResolveRoute = createLegalResolveRoute();
