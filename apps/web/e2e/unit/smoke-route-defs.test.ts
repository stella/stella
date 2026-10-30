import { expect, test } from "bun:test";

import { networkBaselineKey } from "../helpers/smoke-route-coverage";
import {
  scaleSmokeRouteDef,
  SMOKE_ROUTE_DEFS,
} from "../helpers/smoke-route-defs";

test("baseline callers retain redirects while enrolled scale callers measure lists", () => {
  const route = SMOKE_ROUTE_DEFS.find(
    ({ template }) => template === "/workspaces/$workspaceId/lists",
  );
  if (route === undefined) {
    throw new Error("List route is missing from the smoke inventory");
  }
  expect(route.expectation).toEqual({ kind: "redirectsTo", to: "/workspaces" });
  const scaled = scaleSmokeRouteDef(route);
  expect(scaled.expectation).toEqual({ kind: "rendersInPlace" });
  expect(scaled).not.toEqual(route);
  expect(networkBaselineKey(route)).toBe(
    "/workspaces/$workspaceId/lists target",
  );
  expect(networkBaselineKey(scaled)).toBe("/workspaces/$workspaceId/lists");
});

test("scale callers preserve every other route contract", () => {
  const routes = SMOKE_ROUTE_DEFS.filter(
    ({ template }) => template !== "/workspaces/$workspaceId/lists",
  );
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    expect(scaleSmokeRouteDef(route)).toBe(route);
  }
});
