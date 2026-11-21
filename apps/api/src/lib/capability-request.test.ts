import { afterAll, describe, expect, test } from "bun:test";

import {
  CAPABILITY_REQUEST_ERROR_CODE,
  CAPABILITY_REQUEST_HEADER,
} from "@stll/api-contract/capability-request";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { RouteDefinition } from "@/api/http/route";
import {
  buildCapabilityIndex,
  capabilityRequestGuard,
} from "@/api/lib/capability-request";
import type { CapabilityEndpoint } from "@/api/lib/capability-request";
import { serveForTest } from "@/api/tests/helpers/test-server";

const answering = (answer: string): RouteDefinition => ({
  access: "public",
  config: {},
  run: async () => await Promise.resolve(answer),
});

const createThing = { id: "things.create", definition: answering("created") };
const updateThing = { id: "things.update", definition: answering("updated") };
const readHealth = answering("ok");

const loads: string[] = [];
const loadEndpoints = async (): Promise<readonly CapabilityEndpoint[]> => {
  loads.push("load");
  return await Promise.resolve([createThing, updateThing]);
};

const server = serveForTest(
  createHttpApp({
    middleware: [capabilityRequestGuard(loadEndpoints)],
    routes: routes({
      "/things": { POST: createThing.definition },
      "/things/:id": { PATCH: updateThing.definition },
      "/health": { GET: readHealth },
    }),
  }),
);

afterAll(async () => {
  await server.stop();
});

const send = async ({
  method,
  path,
  declared,
}: {
  method: string;
  path: string;
  declared?: string;
}) =>
  await server.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers:
        declared === undefined ? {} : { [CAPABILITY_REQUEST_HEADER]: declared },
    }),
  );

describe("capability index", () => {
  test("maps each capability's route definition to its id", () => {
    const index = buildCapabilityIndex([createThing, updateThing]);

    expect(index.get(createThing.definition)).toBe("things.create");
    expect(index.get(updateThing.definition)).toBe("things.update");
    expect(index.get(readHealth)).toBeUndefined();
    expect(index.size).toBe(2);
  });

  test("refuses two capabilities that share one definition", () => {
    expect(() =>
      buildCapabilityIndex([
        createThing,
        { id: "things.copy", definition: createThing.definition },
      ]),
    ).toThrow("share one definition");
  });

  test("admits the same capability listed twice", () => {
    expect(buildCapabilityIndex([createThing, createThing]).size).toBe(1);
  });
});

describe("capability request guard", () => {
  test("leaves requests without a declaration untouched and loads nothing", async () => {
    loads.length = 0;
    const response = await send({ method: "POST", path: "/things" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("created");
    expect(loads).toEqual([]);
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

  test("refuses a declaration on a path no route serves", async () => {
    const response = await send({
      method: "POST",
      path: "/nowhere",
      declared: "things.create",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: CAPABILITY_REQUEST_ERROR_CODE,
    });
  });

  test("builds the index once across declaring requests", async () => {
    let fresh = 0;
    await using guarded = serveForTest(
      createHttpApp({
        middleware: [
          capabilityRequestGuard(async () => {
            fresh += 1;
            return await Promise.resolve([createThing]);
          }),
        ],
        routes: routes({ "/things": { POST: createThing.definition } }),
      }),
    );
    for (const declared of ["things.create", "things.create", "other"]) {
      await guarded.fetch(
        new Request("http://localhost/things", {
          method: "POST",
          headers: { [CAPABILITY_REQUEST_HEADER]: declared },
        }),
      );
    }

    expect(fresh).toBe(1);
  });
});
