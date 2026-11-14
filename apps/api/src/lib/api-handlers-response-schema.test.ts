import { afterAll, describe, expect, expectTypeOf, test } from "bun:test";
import * as v from "valibot";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { ResponseSchemas, RouteDefinition } from "@/api/http/route";
import { status } from "@/api/http/status";
import {
  safeHandlerResponseSchemas,
  safeHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { serveForTest } from "@/api/tests/helpers/test-server";

const response = {
  ...safeHandlerResponseSchemas(v.strictObject({ ok: v.literal(true) })),
  404: v.strictObject({ error: v.literal("Not Found") }),
};
type ResponseKeepsSuccess = 200 extends keyof typeof response ? true : false;
const responseWithStatusText = safeHandlerResponseSchemasWithStatusText(
  v.strictObject({ ok: v.literal(true) }),
);

/** A public route answering `answer()`, checked against `schemas`. */
const answering = (
  answer: () => unknown,
  schemas: ResponseSchemas,
): RouteDefinition => ({
  access: "public",
  config: { response: schemas },
  run: async () => await answer(),
});

const success = v.strictObject({ reported: v.literal(true) });
const standardResponses = safeHandlerResponseSchemas(success);

const server = serveForTest(
  createHttpApp({
    middleware: [],
    routes: routes({
      "/invalid": {
        GET: answering(
          () => status(400, { message: "Invalid request" }),
          response,
        ),
      },
      "/unauthorized": {
        GET: answering(() => status(401), responseWithStatusText),
      },
      "/success": {
        GET: answering(() => ({ reported: true }), standardResponses),
      },
      "/refused": {
        GET: answering(
          () => status(401, { message: "Connect account" }),
          standardResponses,
        ),
      },
    }),
  }),
);

afterAll(async () => {
  await server.stop();
});

describe("safe handler response schemas", () => {
  test("keep the success schema when a route overrides an error status", () => {
    expectTypeOf<ResponseKeepsSuccess>().toEqualTypeOf<true>();
  });

  test("preserve a typed error status beside a 200 schema", async () => {
    const result = await server.fetch("https://example.test/invalid");

    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ message: "Invalid request" });
  });

  test("accept a bodyless status serialized as status text", async () => {
    const result = await server.fetch("https://example.test/unauthorized");

    expect(result.status).toBe(401);
    expect(await result.text()).toBe("Unauthorized");
  });
});

test("standard success schemas share the same typed error responses", async () => {
  expectTypeOf<(typeof standardResponses)[200]>().toEqualTypeOf<
    typeof success
  >();
  const accepted = await server.fetch("https://example.test/success");
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ reported: true });
  const refused = await server.fetch("https://example.test/refused");
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({ message: "Connect account" });
});
