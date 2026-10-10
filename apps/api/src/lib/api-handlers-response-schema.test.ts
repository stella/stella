import { Result } from "better-result";
import { describe, expect, expectTypeOf, test } from "bun:test";
import { Elysia, status, t } from "elysia";
import type { ElysiaCustomStatusResponse } from "elysia";
import * as v from "valibot";

import {
  safeHandlerResponseSchemas,
  safeHandlerResponseSchemasWithStatusText,
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";

const response = {
  ...safeHandlerResponseSchemas(
    t.Object({ ok: t.Literal(true) }, { additionalProperties: false }),
  ),
  404: t.Object(
    { error: t.Literal("Not Found") },
    { additionalProperties: false },
  ),
};
type ResponseKeepsSuccess = 200 extends keyof typeof response ? true : false;
const responseWithStatusText = safeHandlerResponseSchemasWithStatusText(
  t.Object({ ok: t.Literal(true) }, { additionalProperties: false }),
);

const app = new Elysia()
  .get("/invalid", () => status(400, { message: "Invalid request" }), {
    response,
  })
  .get("/unauthorized", () => status(401), {
    response: responseWithStatusText,
  });

describe("safe handler response schemas", () => {
  test("keep the success schema when a route overrides an error status", () => {
    expectTypeOf<ResponseKeepsSuccess>().toEqualTypeOf<true>();
  });

  test("preserve a typed error status beside a 200 schema", async () => {
    const result = await app.handle(
      new Request("https://example.test/invalid"),
    );

    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ message: "Invalid request" });
  });

  test("accept a bodyless status serialized as status text", async () => {
    const result = await app.handle(
      new Request("https://example.test/unauthorized"),
    );

    expect(result.status).toBe(401);
    expect(await result.text()).toBe("Unauthorized");
  });
});

test("bounded public factories preserve inferred success payloads when forwarding handlers", async () => {
  const bounded = createSafeBoundedPublicHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      query: t.Object({ id: t.String() }),
      response: safePublicHandlerResponseSchemasWithStatusText(
        t.Object({ id: t.String() }, { additionalProperties: false }),
      ),
    },
    async function* ({ query }) {
      const id = yield* Result.await(Promise.resolve(Result.ok(query.id)));
      return Result.ok({ id });
    },
  );
  type SuccessPayload<T> = T extends
    | ElysiaCustomStatusResponse<infer _Code, infer _Body, infer _Status>
    | Response
    ? never
    : T;
  type Success = SuccessPayload<Awaited<ReturnType<typeof bounded.handler>>>;
  expectTypeOf<Success>().toEqualTypeOf<{ id: string }>();
  const boundedApp = new Elysia().get("/bounded", bounded.handler, {
    query: bounded.config.query,
    response: bounded.config.response,
  });
  const accepted = await boundedApp.handle(
    new Request("https://example.test/bounded?id=entry"),
  );
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ id: "entry" });
});

test("standard success schemas share the same typed error responses", async () => {
  const success = v.strictObject({ reported: v.literal(true) });
  const standardResponses = safeHandlerResponseSchemas(success);
  expectTypeOf<(typeof standardResponses)[200]>().toEqualTypeOf<
    typeof success
  >();
  const standardApp = new Elysia()
    .get("/success", () => ({ reported: true as const }), {
      response: standardResponses,
    })
    .get("/refused", () => status(401, { message: "Connect account" }), {
      response: standardResponses,
    });
  const accepted = await standardApp.handle(
    new Request("https://example.test/success"),
  );
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ reported: true });
  const refused = await standardApp.handle(
    new Request("https://example.test/refused"),
  );
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({ message: "Connect account" });
});
