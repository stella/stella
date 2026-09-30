import { panic, Result } from "better-result";
import { Elysia } from "elysia";
import type { InternalRoute } from "elysia";

import { env } from "@/api/env";
import {
  actionSizeErrorResponse,
  boundActionJsonResponse,
  boundActionRequest,
  getActionSizePolicy,
  withTenantActionSizePolicy,
} from "@/api/lib/rate-limit/action-size-limits";

export const TENANT_ACTION_DETAIL = "x-stella-tenant-action";

declare module "elysia" {
  type DocumentDecoration = {
    "x-stella-tenant-action"?: boolean;
  };
}

type TenantActionClassifierOptions = {
  routes: readonly InternalRoute[];
  staticRoutes: Readonly<Record<string, Readonly<Record<string, number>>>>;
  strictPath: boolean | undefined;
  aot: boolean | undefined;
};

export const createTenantActionClassifier = ({
  routes,
  staticRoutes,
  strictPath,
  aot,
}: TenantActionClassifierOptions) => {
  // Both registries contain metadata only; matching never dispatches handlers.
  const configuration = {
    aot: false,
    ...(strictPath === undefined ? {} : { strictPath }),
  };
  const registry = new Elysia(configuration);
  const staticRegistry = new Elysia(configuration);
  const matchRoute = registry.router.dynamic.find.bind(registry.router.dynamic);
  const matchStaticRoute = staticRegistry.router.dynamic.find.bind(
    staticRegistry.router.dynamic,
  );
  const routeType = (route: InternalRoute) => {
    const detail = route.hooks.detail;
    return detail !== undefined &&
      TENANT_ACTION_DETAIL in detail &&
      detail[TENANT_ACTION_DETAIL] === true
      ? "tenant"
      : "exempt";
  };
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
    // method misses. Reverse insertion preserves that precedence on collisions.
    for (const [path, indices] of Object.entries(staticRoutes).toReversed()) {
      const methods: Record<string, ReturnType<typeof routeType>> = {};
      for (const [method, index] of Object.entries(indices)) {
        const route = routes.at(index);
        if (route === undefined) {
          panic("Static tenant route index is missing from route history");
        }
        methods[method] = routeType(route);
      }
      staticRegistry.route("ALL", path, methods);
    }
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  type MatchedRoute = ReturnType<typeof registry.router.dynamic.find>;
  const metadata = (match: MatchedRoute) => {
    if (match === null) {
      return undefined;
    }
    const { handle } = match.store;
    if (
      !isRecord(handle) ||
      (handle.type !== "tenant" && handle.type !== "exempt")
    ) {
      return panic("Tenant route registry lost its derived metadata");
    }
    return handle.type;
  };
  return (request: Request): boolean => {
    const path = new URL(request.url).pathname;
    const upgrade =
      request.method === "GET" &&
      (aot === false
        ? request.headers.get("upgrade")?.toLowerCase()
        : request.headers.get("upgrade")) === "websocket";
    if (aot !== false) {
      const match = matchStaticRoute("ALL", path);
      if (match !== null) {
        const methods = match.store.handle;
        if (!isRecord(methods)) {
          return panic("Static tenant route registry lost its method group");
        }
        const selected =
          (upgrade ? methods.WS : undefined) ??
          methods[request.method] ??
          methods.ALL;
        if (selected !== undefined) {
          if (selected !== "tenant" && selected !== "exempt") {
            return panic("Static tenant route disposition is invalid");
          }
          return selected === "tenant";
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
    return selected === "tenant";
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
    enabled = env.FEATURE_ACTION_ADMISSION,
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
    return await boundActionJsonResponse(response, limits.responseBytes);
  });
};
