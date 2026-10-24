import { panic, Result } from "better-result";
import { Elysia } from "elysia";
import type { InternalRoute } from "elysia";
import { encodePath, getLoosePath } from "elysia/utils";

import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  actionSizeErrorResponse,
  boundActionJsonResponse,
  boundActionRequest,
  getActionSizePolicy,
  withTenantActionSizePolicy,
} from "@/api/lib/rate-limit/action-size-limits";

import type { DocumentDecoration } from "./tenant-action-detail";

export const TENANT_ACTION_DETAIL =
  "x-stella-tenant-action" satisfies keyof DocumentDecoration;

type RequestRouteClassifierOptions = {
  routes: readonly InternalRoute[];
  staticRoutes: Readonly<Record<string, Readonly<Record<string, number>>>>;
  strictPath: boolean | undefined;
  aot: boolean | undefined;
  classifyRoute: (route: InternalRoute) => boolean;
};

export const createRequestRouteClassifier = ({
  routes,
  staticRoutes,
  strictPath,
  aot,
  classifyRoute,
}: RequestRouteClassifierOptions) => {
  // The registry and static map hold metadata; matching never dispatches handlers.
  const configuration = {
    aot: false,
    ...(strictPath === undefined ? {} : { strictPath }),
  };
  const registry = new Elysia(configuration);
  const matchRoute = registry.router.dynamic.find.bind(registry.router.dynamic);
  const routeType = (route: InternalRoute) =>
    classifyRoute(route) ? ("included" as const) : ("excluded" as const);
  const routeMetadata = (route: InternalRoute) => ({
    type: routeType(route),
    routeTemplate: route.path,
  });
  const staticMetadata = new Map<
    string,
    Record<string, ReturnType<typeof routeMetadata>>
  >();
  let hasDynamicWebSocket = false;
  for (const route of routes) {
    if (
      aot !== false &&
      staticRoutes[route.path]?.[route.method] !== undefined
    ) {
      continue;
    }
    if (route.method === "WS") {
      hasDynamicWebSocket = true;
    }
    registry.route(route.method, route.path, { type: routeType(route) });
  }
  if (aot !== false) {
    // AOT's first static path group owns its encoded/loose aliases, including
    // method misses. Derive the same aliases with the framework's utilities.
    for (const [path, indices] of Object.entries(staticRoutes)) {
      const methods: Record<string, ReturnType<typeof routeMetadata>> = {};
      for (const [method, index] of Object.entries(indices)) {
        const route = routes.at(index);
        if (route === undefined) {
          panic("Static tenant route index is missing from route history");
        }
        methods[method] = routeMetadata(route);
      }
      const aliases =
        strictPath === true
          ? [path, encodePath(path)]
          : [path, getLoosePath(path), encodePath(path)];
      for (const alias of aliases) {
        if (!staticMetadata.has(alias)) {
          staticMetadata.set(alias, methods);
        }
      }
    }
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  type MatchedRoute = ReturnType<typeof registry.router.dynamic.find>;
  const metadata = (match: MatchedRoute) => {
    if (match === null) {
      return undefined;
    }
    const { handle, route: routeTemplate } = match.store;
    if (
      !isRecord(handle) ||
      (handle["type"] !== "included" && handle["type"] !== "excluded")
    ) {
      return panic("Route classifier registry lost its derived metadata");
    }
    return {
      type:
        handle["type"] === "included"
          ? ("included" as const)
          : ("excluded" as const),
      routeTemplate,
    };
  };
  return (request: Request) => {
    const path = new URL(request.url).pathname;
    const upgrade =
      request.method === "GET" &&
      (aot === false
        ? request.headers.get("upgrade")?.toLowerCase()
        : request.headers.get("upgrade")) === "websocket";
    if (aot !== false) {
      const methods = staticMetadata.get(path);
      if (methods !== undefined) {
        const selected =
          (upgrade ? methods["WS"] : undefined) ??
          methods[request.method] ??
          methods["ALL"];
        if (selected !== undefined) {
          return selected;
        }
      }
    }
    const method =
      upgrade && hasDynamicWebSocket && aot !== false ? "WS" : request.method;
    const selected =
      metadata(matchRoute(method, path)) ??
      (aot === false && upgrade
        ? metadata(matchRoute("WS", path))
        : undefined) ??
      metadata(matchRoute("ALL", path));
    return (
      selected ?? ({ type: "unmatched", routeTemplate: "unmatched" } as const)
    );
  };
};

type TenantActionClassifierOptions = Omit<
  RequestRouteClassifierOptions,
  "classifyRoute"
>;

export const createTenantActionClassifier = (
  options: TenantActionClassifierOptions,
) => {
  const classify = createRequestRouteClassifier({
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
  return (request: Request) => {
    const route = classify(request);
    switch (route.type) {
      case "included":
        return { type: "tenant" as const, routeTemplate: route.routeTemplate };
      case "excluded":
        return { type: "exempt" as const, routeTemplate: route.routeTemplate };
      case "unmatched":
        return {
          type: "unmatched" as const,
          routeTemplate: route.routeTemplate,
        };
      default: {
        route satisfies never;
        return panic("Unknown route classification");
      }
    }
  };
};

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
