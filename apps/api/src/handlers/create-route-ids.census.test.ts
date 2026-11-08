import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import "@/api/tests/setup-env";

import { apiRoutes } from "@/api/api-routes";
import type { RouteEntry } from "@/api/http/route";

const KNOWN_CALLER_MINTED_CREATE_ROUTES = [
  "PUT /v1/views/:workspaceId",
  "PUT /v1/workspaces",
] as const;

const acceptsTopLevelId = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null || !("entries" in body)) {
    return false;
  }
  const { entries } = body;
  return typeof entries === "object" && entries !== null && "id" in entries;
};

const createsResource = ({ definition }: RouteEntry): boolean => {
  const { description } = definition.config;
  return (
    typeof description === "string" && /^(?:Add|Create)\s/u.test(description)
  );
};

export const createRouteIdOffenders = (
  routeEntries: readonly RouteEntry[],
): string[] =>
  routeEntries.flatMap((route) =>
    createsResource(route) && acceptsTopLevelId(route.definition.config.body)
      ? [`${route.method} ${route.path}`]
      : [],
  );

const fixtureRoute = (body: unknown): RouteEntry => ({
  method: "PUT",
  path: "/fixture/widgets",
  middleware: [],
  definition: {
    access: "member",
    config: {
      description: "Create a widget.",
      body: v.strictObject({ id: v.string(), name: v.string() }),
    },
    run: async () => body,
  },
});

describe("create route id census", () => {
  test("fixture proves a caller-selected primary key fails the census", () => {
    expect(createRouteIdOffenders([fixtureRoute({})])).toEqual([
      "PUT /fixture/widgets",
    ]);
  });

  test("new create routes do not accept their primary key", () => {
    expect(createRouteIdOffenders(apiRoutes).toSorted()).toEqual([
      ...KNOWN_CALLER_MINTED_CREATE_ROUTES,
    ]);
  });
});
