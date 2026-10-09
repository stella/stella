import { panic } from "better-result";
import Elysia from "elysia";

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
import type { LegalResolveAuthorization } from "@/api/handlers/legal-resolve/route-handler";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
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
import { LEGAL_RESOLVE_RESOURCE_ROUTES } from "@/api/mcp/resource-policy-contract";

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
  resolveSessionContext?: LegalResolveAuthorizationDependencies["resolveSessionContext"];
  resolveDecision?: typeof resolveDecision;
  resolveLaw?: typeof resolveLawCitation;
};

export const createLegalResolveRoute = ({
  authenticate,
  decisionRateLimit,
  lawRateLimit,
  mayReadPublicLaw,
  publicLawEnabled,
  resolveSessionContext,
  resolveDecision: resolveDecisionRequest = resolveDecision,
  resolveLaw = resolveLawCitation,
}: LegalResolveRouteDependencies = {}) => {
  const isPublicLawEnabled =
    publicLawEnabled ??
    (() => isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"));
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
    .mapResponse(({ set }) => {
      set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
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
            decisionRateLimit ??
              createLegalResolveRateLimitOptions("decision", getAuthorization),
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
            lawRateLimit ??
              createLegalResolveRateLimitOptions("law", getAuthorization),
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
