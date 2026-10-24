import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
  CAPABILITY_REQUEST_ERROR_CODE,
  CAPABILITY_REQUEST_HEADER,
} from "@stll/api-contract/capability-request";

import {
  buildCapabilityRouteIndex,
  capabilityRequestGuard,
  type MountedRoute,
  resolveCapabilityRequest,
} from "@/api/lib/capability-request";

const createThing = { id: "things.create", handler: () => "created" };
const updateThing = { id: "things.update", handler: () => "updated" };
const readHealth = () => "ok";

const createApp = () => {
  const app = new Elysia()
    .use(
      capabilityRequestGuard({
        mountedRoutes: (): readonly MountedRoute[] => app.routes,
        loadEndpoints: async () => [createThing, updateThing],
      }),
    )
    .post("/things", createThing.handler)
    .patch("/things/:id", updateThing.handler)
    .get("/health", readHealth);
  return app;
};

const send = async ({
  method,
  path,
  declared,
}: {
  method: string;
  path: string;
  declared?: string;
}) =>
  await createApp().handle(
    new Request(`http://localhost${path}`, {
      method,
      headers:
        declared === undefined ? {} : { [CAPABILITY_REQUEST_HEADER]: declared },
    }),
  );

describe("capability route index", () => {
  test("maps each route to the capability whose handler it registers", () => {
    const index = buildCapabilityRouteIndex({
      routes: [
        { method: "POST", path: "/things", handler: createThing.handler },
        { method: "PATCH", path: "/things/:id", handler: updateThing.handler },
        { method: "GET", path: "/health", handler: readHealth },
      ],
      endpoints: [createThing, updateThing],
    });

    expect([...index]).toEqual([
      ["POST /things", "things.create"],
      ["PATCH /things/:id", "things.update"],
    ]);
  });

  test("refuses two capabilities that share one handler", () => {
    expect(() =>
      buildCapabilityRouteIndex({
        routes: [],
        endpoints: [
          createThing,
          { id: "things.copy", handler: createThing.handler },
        ],
      }),
    ).toThrow("share one handler");
  });

  test("classifies undeclared, matched and mismatched requests", () => {
    const index = new Map([["POST /things", "things.create"]]);
    const resolve = (declared: string | null, route: string) =>
      resolveCapabilityRequest({ declared, method: "POST", route, index });

    expect(resolve(null, "/things")).toEqual({ type: "undeclared" });
    expect(resolve("things.create", "/things")).toEqual({
      type: "matched",
      capability: "things.create",
    });
    expect(resolve("things.update", "/things")).toEqual({
      type: "mismatched",
      declared: "things.update",
      routeCapability: "things.create",
    });
    expect(resolve("things.create", "/health")).toEqual({
      type: "mismatched",
      declared: "things.create",
      routeCapability: null,
    });
  });
});

describe("capability request guard", () => {
  test("leaves requests without a declaration untouched", async () => {
    const response = await send({ method: "POST", path: "/things" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("created");
  });

  test("runs a request whose declaration owns the route", async () => {
    const response = await send({
      method: "PATCH",
      path: "/things/1",
      declared: "things.update",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("updated");
  });

  test.each([
    { method: "POST", path: "/things", declared: "things.update" },
    { method: "GET", path: "/health", declared: "things.create" },
  ])("refuses $declared on $method $path", async (request) => {
    const response = await send(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: CAPABILITY_REQUEST_ERROR_CODE,
    });
  });
});
