// parser-output-unchanged: tracks exception capture ownership in async context only; parser values are unchanged.
import type { ExceptionScope, RequestExceptionScope } from "@stll/errors";
import { getExceptionScopes as getInheritedExceptionScopes } from "@stll/errors/exception-scope-context";

import { getMountedRequestRoute } from "@/api/lib/observability/request-context";

export { withExceptionScope } from "@stll/errors/exception-scope-context";

export const getRequestExceptionScopes = (): readonly ExceptionScope[] => {
  const mountedRoute = getMountedRequestRoute();
  return getInheritedExceptionScopes().map((scope) => {
    if (scope.type !== "request" || mountedRoute === undefined) {
      return scope;
    }
    const wildcard = scope.routeTemplate.indexOf("*");
    if (
      wildcard === -1 ||
      !mountedRoute.startsWith(scope.routeTemplate.slice(0, wildcard))
    ) {
      return scope;
    }
    return { ...scope, routeTemplate: mountedRoute };
  });
};

export const getExceptionScope = (): ExceptionScope | undefined =>
  getRequestExceptionScopes().at(-1);

const isRequestScope = (
  scope: ExceptionScope,
): scope is RequestExceptionScope => scope.type === "request";

/**
 * The route template of the request in flight, as the request pipeline
 * declared it (a mounted sub-route resolved); undefined outside a request.
 */
export const getRequestRouteScope = (): RequestExceptionScope | undefined =>
  getRequestExceptionScopes().findLast(isRequestScope);
