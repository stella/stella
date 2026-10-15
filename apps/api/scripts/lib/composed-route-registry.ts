import { panic } from "better-result";
import type { InternalRoute } from "elysia";

import {
  discoverSafeHandlers,
  type CollectedEndpoint,
} from "./enumerate-safe-handlers";

export type ComposedRouteRow = {
  id: string;
  method: string;
  path: string;
  hooks: unknown;
  handler: InternalRoute["handler"];
  handlerEndpoint?: string;
  endpoint?: CollectedEndpoint;
};

/** Join the mounted registry to endpoint declarations by executable identity. */
export const collectComposedRouteRows = (
  routes: readonly InternalRoute[],
  endpoints: readonly CollectedEndpoint[],
): ComposedRouteRow[] => {
  const endpointByHandler = new Map(
    endpoints.map((endpoint) => [endpoint.handler, endpoint]),
  );
  return routes.map(({ method, path, hooks, handler }) => {
    const endpoint = endpointByHandler.get(handler);
    return {
      id: `${method} ${path}`,
      method,
      path,
      hooks,
      handler,
      ...(endpoint === undefined
        ? {}
        : { handlerEndpoint: endpoint.id, endpoint }),
    };
  });
};

/** Runtime consumers share one composed route universe and endpoint join. */
export const loadComposedRouteRegistry = async () => {
  await import("../../src/tests/setup-env");
  const { default: api } = await import("../../src/server");
  const discovery = await discoverSafeHandlers();
  if (discovery.importErrors.length !== 0) {
    panic(
      `Composed route registry could not load: ${discovery.importErrors.map(({ id }) => id).join(", ")}`,
    );
  }
  return {
    api,
    discovery,
    rows: collectComposedRouteRows(api.routes, discovery.endpoints),
  };
};
