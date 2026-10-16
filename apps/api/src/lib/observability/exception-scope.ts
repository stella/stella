// parser-output-unchanged: tracks exception capture ownership in async context only; parser values are unchanged.
import { AsyncLocalStorage } from "node:async_hooks";

import type { ExceptionScope } from "@stll/errors";

import { getMountedRequestRoute } from "@/api/lib/observability/request-context";

const captureScope = new AsyncLocalStorage<readonly ExceptionScope[]>();

/** Scope every nested capture, including detached continuations, at its owner. */
export const withExceptionScope = <TResult>(
  scope: ExceptionScope,
  operation: () => TResult,
): TResult =>
  captureScope.run([...(captureScope.getStore() ?? []), scope], operation);

export const getExceptionScopes = (): readonly ExceptionScope[] => {
  const mountedRoute = getMountedRequestRoute();
  return (captureScope.getStore() ?? []).map((scope) => {
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
  getExceptionScopes().at(-1);
