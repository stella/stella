// Placeholder for the committed, generated route tree (spec 051 S5.2, build-time
// call site). The real file is produced by a codegen script that projects
// `DEFAULT_MCP_TOOL_DEFINITIONS` through `generateRouteMap` and serializes the
// result here; drift then shows up as a PR diff instead of a runtime surprise.
//
// Neither the codegen script nor `generateRouteMap` exist yet (Phase 1 scaffolds
// the package shell only), so this module exports an empty route with no
// children until Phase 3 wires the generator up.

import type { RouteNode } from "../route-types.js";

export const generatedRouteMap: RouteNode = {
  kind: "route",
  children: {},
};
