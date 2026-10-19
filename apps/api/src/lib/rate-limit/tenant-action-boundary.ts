import { Result } from "better-result";
import type { InternalRoute } from "elysia";

import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  actionSizeErrorResponse,
  boundActionJsonResponse,
  boundActionRequest,
  getActionSizePolicy,
  withTenantActionSizePolicy,
} from "@/api/lib/rate-limit/action-size-limits";
import { createRouteRegistryMatcher } from "@/api/lib/route-registry-matcher";

import type { DocumentDecoration } from "./tenant-action-detail";

export const TENANT_ACTION_DETAIL =
  "x-stella-tenant-action" satisfies keyof DocumentDecoration;

type RequestRouteClassifierOptions = Parameters<
  typeof createRouteRegistryMatcher
>[0] & {
  classifyRoute: (route: InternalRoute) => boolean;
};

export const createRequestRouteClassifier = ({
  classifyRoute,
  ...options
}: RequestRouteClassifierOptions) => {
  const matchRoute = createRouteRegistryMatcher(options);
  // Snapshot declarations at construction, as the route classifier always did.
  const includedRoutes = new Set(options.routes.filter(classifyRoute));
  return (request: Request): boolean => {
    const route = matchRoute(request);
    return route !== undefined && includedRoutes.has(route);
  };
};

type TenantActionClassifierOptions = Omit<
  RequestRouteClassifierOptions,
  "classifyRoute"
>;

export const createTenantActionClassifier = (
  options: TenantActionClassifierOptions,
) =>
  createRequestRouteClassifier({
    ...options,
    classifyRoute: (route) => {
      // Elysia exposes hooks as any; narrow its metadata at this boundary.
      const hooks: unknown = route.hooks;
      if (typeof hooks !== "object" || hooks === null || !("detail" in hooks)) {
        return false;
      }
      const { detail } = hooks;
      return (
        typeof detail === "object" &&
        detail !== null &&
        TENANT_ACTION_DETAIL in detail &&
        detail[TENANT_ACTION_DETAIL] === true
      );
    },
  });

type TenantHttpActionOptions = {
  handleRequest: (request: Request) => Response | Promise<Response>;
  isTenantAction: (request: Request) => boolean;
  policy?: typeof getActionSizePolicy;
  enabled?: boolean;
  decorateRefusal?: (response: Response, request: Request) => Response;
};

export const runTenantHttpAction = (
  request: Request,
  {
    handleRequest,
    isTenantAction,
    policy = getActionSizePolicy,
    enabled = isDeploymentFeatureEnabled("FEATURE_ACTION_ADMISSION"),
    decorateRefusal,
  }: TenantHttpActionOptions,
): Response | Promise<Response> => {
  if (!enabled || !isTenantAction(request)) {
    return handleRequest(request);
  }
  const resolved = policy();
  if (Result.isError(resolved)) {
    const response = actionSizeErrorResponse(resolved.error);
    return decorateRefusal === undefined
      ? response
      : decorateRefusal(response, request);
  }
  if (resolved.value === undefined) {
    return handleRequest(request);
  }
  const limits = resolved.value;
  return withTenantActionSizePolicy(limits, async () => {
    const bounded = await boundActionRequest(request, limits.requestBytes);
    if (Result.isError(bounded)) {
      const response = actionSizeErrorResponse(
        bounded.error,
        limits.responseBytes,
      );
      return decorateRefusal === undefined
        ? response
        : decorateRefusal(response, request);
    }
    const response = await handleRequest(bounded.value);
    return await boundActionJsonResponse(response, {
      maximum: limits.responseBytes,
      disposition:
        request.method === "GET" || request.method === "HEAD"
          ? "refuse"
          : "preserve_success",
      operation: request.method,
    });
  });
};
