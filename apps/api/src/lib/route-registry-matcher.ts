import { panic } from "better-result";
import { Elysia } from "elysia";
import type { InternalRoute } from "elysia";
import { encodePath, getLoosePath } from "elysia/utils";

type RouteRegistryMatcherOptions = {
  routes: readonly InternalRoute[];
  staticRoutes: Readonly<Record<string, Readonly<Record<string, number>>>>;
  strictPath: boolean | undefined;
  aot: boolean | undefined;
};

export const createRouteRegistryMatcher = ({
  routes: registeredRoutes,
  staticRoutes,
  strictPath,
  aot,
}: RouteRegistryMatcherOptions) => {
  const routes = [...registeredRoutes];
  // The registry and static map hold metadata; matching never dispatches handlers.
  const configuration = {
    aot: false,
    ...(strictPath === undefined ? {} : { strictPath }),
  };
  const registry = new Elysia(configuration);
  const matchRoute = registry.router.dynamic.find.bind(registry.router.dynamic);
  const staticMetadata = new Map<string, Record<string, InternalRoute>>();
  let hasDynamicWebSocket = false;
  for (const [index, route] of routes.entries()) {
    if (
      aot !== false &&
      staticRoutes[route.path]?.[route.method] !== undefined
    ) {
      continue;
    }
    if (route.method === "WS") {
      hasDynamicWebSocket = true;
    }
    registry.route(route.method, route.path, { index });
  }
  if (aot !== false) {
    // AOT's first static path group owns its encoded/loose aliases, including
    // method misses. Derive the same aliases with the framework's utilities.
    for (const [path, indices] of Object.entries(staticRoutes)) {
      const methods = Object.fromEntries(
        Object.entries(indices).map(([method, index]) => {
          const route = routes.at(index);
          if (route === undefined) {
            panic("Static route index is missing from route history");
          }
          return [method, route];
        }),
      );
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
    const { handle } = match.store;
    if (!isRecord(handle) || typeof handle["index"] !== "number") {
      return panic("Route registry lost its derived metadata");
    }
    const route = routes.at(handle["index"]);
    if (route === undefined) {
      return panic("Matched route index is missing from route history");
    }
    return route;
  };
  return (request: Request): InternalRoute | undefined => {
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
    return selected;
  };
};
