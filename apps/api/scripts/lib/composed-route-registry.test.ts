import { expect, test } from "bun:test";
import { Elysia, t } from "elysia";

import type { HandlerConfig } from "../../src/lib/api-handlers";
import { collectComposedRouteRows } from "./composed-route-registry";
import type { CollectedEndpoint } from "./enumerate-safe-handlers";

test("composed rows preserve every mounted route and join declarations by exact handler identity", () => {
  const handler = () => "ok";
  const endpoint = {
    id: "apps/api/src/handlers/fixture/read.ts",
    exportName: undefined,
    config: {
      permissions: { workspace: ["read"] },
      accountAccess: "sandbox",
      requiresUsage: { actionType: "chat" },
    } satisfies Pick<
      HandlerConfig,
      "permissions" | "accountAccess" | "requiresUsage"
    >,
    handler,
    exposure: { type: "internal", reason: "fixture" },
  } satisfies CollectedEndpoint;
  const child = new Elysia({ prefix: "/items" })
    .get("/:id", handler, {
      response: t.String(),
      detail: { description: "Fixture declaration" },
    })
    .get("/alias/:id", handler)
    .post("/raw", () => "ok");
  const api = new Elysia().group("/v1", (app) => app.use(child));
  const rows = collectComposedRouteRows(api.routes, [endpoint]);

  expect(rows.map(({ id }) => id)).toEqual([
    "GET /v1/items/:id",
    "GET /v1/items/alias/:id",
    "POST /v1/items/raw",
  ]);
  expect(rows).toHaveLength(api.routes.length);
  for (const [index, row] of rows.entries()) {
    expect(row.hooks).toBe(api.routes.at(index)?.hooks);
    expect(row.handler).toBe(api.routes.at(index)?.handler);
  }
  for (const row of rows.slice(0, 2)) {
    expect(row.endpoint).toBe(endpoint);
    expect(row.endpoint?.config).toBe(endpoint.config);
    expect(row.handlerEndpoint).toBe(endpoint.id);
  }
  expect(rows.at(0)).toMatchObject({
    method: "GET",
    path: "/v1/items/:id",
    hooks: { detail: { description: "Fixture declaration" } },
  });
  expect(rows.at(2)).not.toHaveProperty("endpoint");
  expect(rows.at(2)).not.toHaveProperty("handlerEndpoint");
});
