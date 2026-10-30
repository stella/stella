import { panic } from "better-result";
import path from "node:path";

import {
  CREATE_ROUTES_MARKER,
  parseIdempotentCreateRoutes,
} from "@stll/scripts/src/idempotent-create-routes";
import type { IdempotentCreateRoute } from "@stll/scripts/src/idempotent-create-routes";

const routeKey = ({ method, path: routePath }: IdempotentCreateRoute) => {
  const segments = routePath
    .split("/")
    .filter(Boolean)
    .filter((part, index) => index !== 0 || part !== "v1")
    .map((part) => (part.startsWith(":") ? "*" : part));
  return `${method.toLowerCase()}:${segments.join("/")}`;
};

export const createRouteInventory = (
  routes: readonly IdempotentCreateRoute[],
) => ({
  all: new Set(routes.map(routeKey)),
  replay: new Set(routes.filter((route) => route.replay).map(routeKey)),
  excluded: new Set(routes.filter((route) => !route.replay).map(routeKey)),
});

/** Read the API's mounted definitions rather than reconstructing its router. */
export const liveCreateRouteRows = () => {
  const result = Bun.spawnSync([
    "bun",
    "--preload",
    path.resolve(import.meta.dirname, "../../../api/src/tests/setup-env.ts"),
    path.resolve(
      import.meta.dirname,
      "../../../api/scripts/idempotent-create-routes.ts",
    ),
  ]);
  if (result.exitCode !== 0) {
    panic(
      `Cannot read the API mounted create route projection (exit ${String(result.exitCode)}, signal ${String(result.signalCode)}): ${result.stderr.toString()}`,
    );
  }
  const output = result.stdout
    .toString()
    .split("\n")
    .find((line) => line.startsWith(CREATE_ROUTES_MARKER));
  if (output === undefined) {
    panic("API mounted create route projection is missing");
  }
  return parseIdempotentCreateRoutes(
    JSON.parse(output.slice(CREATE_ROUTES_MARKER.length)),
  );
};
