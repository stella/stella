import { panic, TaggedError } from "better-result";
import { Elysia } from "elysia";

import {
  CAPABILITY_REQUEST_ERROR_CODE,
  CAPABILITY_REQUEST_HEADER,
} from "@stll/api-contract/capability-request";
import { declareFailureClass } from "@stll/errors";

import { captureRequestError } from "@/api/lib/analytics/capture";
import { httpError } from "@/api/lib/errors/http-error";

export type MountedRoute = { method: string; path: string; handler: unknown };

export type CapabilityEndpoint = { id: string; handler: unknown };

type CapabilityRouteIndex = ReadonlyMap<string, string>;

const routeKey = ({ method, path }: { method: string; path: string }) =>
  `${method} ${path}`;

type BuildCapabilityRouteIndexOptions = {
  routes: readonly MountedRoute[];
  endpoints: readonly CapabilityEndpoint[];
};

/**
 * The catalog capability behind each mounted route, keyed by `METHOD path`.
 * Routes register the endpoint's own handler function, so handler identity
 * ties a route to the capability without a second, hand-kept route table.
 */
export const buildCapabilityRouteIndex = ({
  routes,
  endpoints,
}: BuildCapabilityRouteIndexOptions): CapabilityRouteIndex => {
  const idByHandler = new Map<unknown, string>();
  for (const { id, handler } of endpoints) {
    const existing = idByHandler.get(handler);
    if (existing !== undefined && existing !== id) {
      return panic(`capabilities ${existing} and ${id} share one handler`);
    }
    idByHandler.set(handler, id);
  }
  const index = new Map<string, string>();
  for (const route of routes) {
    const id = idByHandler.get(route.handler);
    if (id !== undefined) {
      index.set(routeKey(route), id);
    }
  }
  return index;
};

type CapabilityRequestOutcome =
  | { type: "undeclared" }
  | { type: "matched"; capability: string }
  | { type: "mismatched"; declared: string; routeCapability: string | null };

type ResolveCapabilityRequestOptions = {
  declared: string | null;
  method: string;
  route: string;
  index: CapabilityRouteIndex;
};

export const resolveCapabilityRequest = ({
  declared,
  method,
  route,
  index,
}: ResolveCapabilityRequestOptions): CapabilityRequestOutcome => {
  if (declared === null) {
    return { type: "undeclared" };
  }
  const routeCapability = index.get(routeKey({ method, path: route })) ?? null;
  if (routeCapability === declared) {
    return { type: "matched", capability: declared };
  }
  return { type: "mismatched", declared, routeCapability };
};

class CapabilityRequestMismatchError extends TaggedError(
  "CapabilityRequestMismatchError",
)<{
  message: string;
  declared: string;
  routeCapability: string | null;
}> {
  static {
    declareFailureClass(this, "request_invalid");
  }
}

type CapabilityRequestGuardOptions = {
  mountedRoutes: () => readonly MountedRoute[];
  loadEndpoints: () => Promise<readonly CapabilityEndpoint[]>;
};

/**
 * Refuses a request whose declared capability differs from the capability of
 * the route it reached. Requests without the header are unaffected. The index
 * is built once, on the first declaring request, after every route is mounted.
 */
export const capabilityRequestGuard = ({
  mountedRoutes,
  loadEndpoints,
}: CapabilityRequestGuardOptions) => {
  let index: Promise<CapabilityRouteIndex> | undefined;
  const getIndex = async () =>
    await (index ??= (async () =>
      buildCapabilityRouteIndex({
        routes: mountedRoutes(),
        endpoints: await loadEndpoints(),
      }))());

  return new Elysia().onBeforeHandle(
    { as: "global" },
    async ({ request, route, set }) => {
      const declared = request.headers.get(CAPABILITY_REQUEST_HEADER);
      if (declared === null) {
        return undefined;
      }
      const outcome = resolveCapabilityRequest({
        declared,
        method: request.method,
        route,
        index: await getIndex(),
      });
      switch (outcome.type) {
        case "undeclared":
        case "matched":
          return undefined;
        case "mismatched":
          captureRequestError(
            new CapabilityRequestMismatchError({
              message: "Declared capability does not own the matched route",
              declared: outcome.declared,
              routeCapability: outcome.routeCapability,
            }),
            {
              request,
              fingerprintKey: "capabilityRequestGuard.mismatch",
              scope: {
                type: "handler",
                handlerId: "capabilityRequestGuard.mismatch",
              },
            },
          );
          set.status = 400;
          return httpError(
            "The request names a capability that does not own this route.",
            CAPABILITY_REQUEST_ERROR_CODE,
          );
        default:
          outcome satisfies never;
          return panic(
            `Unhandled capability request outcome: ${String(outcome)}`,
          );
      }
    },
  );
};
