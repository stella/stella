import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createHttpApp } from "@/api/http/app";
import { isHttpFailure } from "@/api/http/errors";
import type { HttpFailureKind } from "@/api/http/errors";
import { toResponse } from "@/api/http/respond";
import { routes } from "@/api/http/route";
import type {
  Middleware,
  RouteConfig,
  RouteDefinition,
  RouteRequest,
} from "@/api/http/route";
import { status } from "@/api/http/status";
import { serveForTest } from "@/api/tests/helpers/test-server";

/** A public definition answering with `answer(request)`. */
const definition = (
  answer: (request: RouteRequest) => unknown,
  config: RouteConfig = {},
): RouteDefinition => ({
  access: "public",
  config,
  run: async (request) => await answer(request),
});

const order: string[] = [];
const trace =
  (name: string): Middleware =>
  async (_ctx, inner) => {
    order.push(`${name}:in`);
    try {
      return await inner();
    } finally {
      order.push(`${name}:out`);
    }
  };

const FAILURE_STATUS: Readonly<Record<HttpFailureKind, number>> = {
  malformed: 400,
  invalid_request: 422,
  invalid_response: 500,
  not_found: 404,
  method_not_allowed: 405,
};

/** The minimal error boundary the production pipeline supplies in full. */
const errorBoundary: Middleware = async (ctx, inner) => {
  try {
    return await inner();
  } catch (error) {
    if (!isHttpFailure(error)) {
      throw error;
    }
    if (error.allow !== undefined) {
      ctx.set.headers["allow"] = error.allow.join(", ");
    }
    return toResponse(
      status(FAILURE_STATUS[error.kind], { kind: error.kind }),
      ctx.set,
    );
  }
};

const echoBody = definition(async ({ readBody }) => ({
  body: await readBody(),
}));
const noteSchema = { response: { 200: v.object({ id: v.string() }) } };

const app = createHttpApp({
  middleware: [trace("outer"), errorBoundary, trace("inner")],
  routes: [
    ...routes({
      "/ping": { GET: definition(() => "pong") },
      "/items/:itemId": {
        GET: definition(({ ctx }) => ({
          params: ctx.params,
          query: ctx.query,
        })),
      },
      "/echo": { POST: echoBody },
      "/text": {
        POST: definition(async ({ readBody }) => ({ body: await readBody() }), {
          bodyMode: "text",
        }),
      },
      "/cookie": {
        POST: definition(({ ctx }) => {
          ctx.set.headers["set-cookie"] = ["a=1; Path=/", "b=2; Path=/"];
          return new Response("raw", { headers: { "x-raw": "1" } });
        }),
      },
      "/conflict": { GET: definition(() => status(409)) },
      "/gone": { DELETE: definition(() => status(204)) },
      "/null": { GET: definition(() => null) },
    }),
    ...routes(
      {
        "/:noteId": {
          GET: definition(
            ({ ctx }) => ({ id: ctx.params["noteId"], secret: "internal" }),
            noteSchema,
          ),
        },
        "/:noteId/broken": {
          GET: definition(() => ({ id: 7 }), noteSchema),
        },
      },
      { prefix: "/notes", middleware: [trace("group")] },
    ),
  ],
});

const server = serveForTest(app);
afterAll(async () => {
  await server.stop();
});

describe("routing", () => {
  test("serves a route and its trailing-slash twin", async () => {
    const plain = await server.fetch("http://localhost/ping");
    const slashed = await server.fetch("http://localhost/ping/");
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe("pong");
    expect(plain.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await slashed.text()).toBe("pong");
  });

  test("decodes path params and keeps repeated query keys", async () => {
    const response = await server.fetch(
      "http://localhost/items/a%20b?tag=x&tag=y&single=1",
    );
    expect(await response.json()).toEqual({
      params: { itemId: "a b" },
      query: { tag: ["x", "y"], single: "1" },
    });
  });

  test("answers 404 for an unknown path and 405 with Allow for a wrong method", async () => {
    const missing = await server.fetch("http://localhost/nowhere");
    expect(missing.status).toBe(404);
    const wrongMethod = await server.fetch("http://localhost/ping", {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
  });

  test("answers HEAD from the GET route without a body", async () => {
    const response = await server.fetch("http://localhost/ping", {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("runs global middleware outermost first, then the group's", async () => {
    order.length = 0;
    await server.fetch("http://localhost/notes/n1");
    expect(order).toEqual([
      "outer:in",
      "inner:in",
      "group:in",
      "group:out",
      "inner:out",
      "outer:out",
    ]);
  });

  test("runs global middleware around unmatched paths too", async () => {
    order.length = 0;
    await server.fetch("http://localhost/nowhere");
    expect(order).toEqual(["outer:in", "inner:in", "inner:out", "outer:out"]);
  });

  test("a stage's replacement context reaches inner stages and the route of that request only", async () => {
    const seen: string[] = [];
    const tag = (ctx: { request: Request }) =>
      ctx.request.headers.get("x-tag") ?? "none";
    const observe =
      (name: string): Middleware =>
      async (ctx, inner) => {
        seen.push(`${name}:${tag(ctx)}`);
        return await inner();
      };
    const replace: Middleware = async (ctx, inner) => {
      const headers = new Headers(ctx.request.headers);
      headers.set("x-tag", `replaced-${tag(ctx)}`);
      return await inner({
        ...ctx,
        request: new Request(ctx.request, { headers }),
      });
    };
    const replacing = serveForTest(
      createHttpApp({
        middleware: [observe("outer"), replace, observe("inner")],
        routes: routes(
          { "/tag": { GET: definition(({ ctx }) => tag(ctx)) } },
          { middleware: [observe("group")] },
        ),
      }),
    );
    try {
      const first = await replacing.fetch("http://localhost/tag", {
        headers: { "x-tag": "a" },
      });
      const second = await replacing.fetch("http://localhost/tag");
      expect(await first.text()).toBe("replaced-a");
      expect(await second.text()).toBe("replaced-none");
      expect(seen).toEqual([
        "outer:a",
        "inner:replaced-a",
        "group:replaced-a",
        "outer:none",
        "inner:replaced-none",
        "group:replaced-none",
      ]);
    } finally {
      await replacing.stop();
    }
  });
});

describe("answers", () => {
  test("a bare status sends its status text, a bodiless status sends none", async () => {
    const conflict = await server.fetch("http://localhost/conflict");
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toBe("Conflict");
    const gone = await server.fetch("http://localhost/gone", {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe("");
  });

  test("null is a JSON document, not an empty body", async () => {
    const response = await server.fetch("http://localhost/null");
    expect(response.headers.get("content-type")).toBe(
      "application/json;charset=utf-8",
    );
    expect(await response.json()).toBeNull();
  });

  test("a raw response keeps its headers and gains every accumulated cookie", async () => {
    const response = await server.fetch("http://localhost/cookie", {
      method: "POST",
    });
    expect(response.headers.get("x-raw")).toBe("1");
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
    expect(await response.text()).toBe("raw");
  });

  test("sends only the fields the response schema declares", async () => {
    const response = await server.fetch("http://localhost/notes/n1");
    expect(await response.json()).toEqual({ id: "n1" });
  });

  test("an answer that breaks its response schema is the server's 500", async () => {
    const response = await server.fetch("http://localhost/notes/n1/broken");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ kind: "invalid_response" });
  });
});

describe("bodies", () => {
  test("reads JSON, url-encoded and flat multipart bodies", async () => {
    const json = await server.fetch("http://localhost/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: [1, 2] }),
    });
    expect(await json.json()).toEqual({ body: { a: [1, 2] } });

    const form = new FormData();
    form.append("payload", '{"kept":"as text"}');
    form.append("tag", "x");
    form.append("tag", "y");
    const multipart = await server.fetch("http://localhost/echo", {
      method: "POST",
      body: form,
    });
    expect(await multipart.json()).toEqual({
      body: { payload: '{"kept":"as text"}', tag: ["x", "y"] },
    });

    const encoded = await server.fetch("http://localhost/echo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1&__proto__=x",
    });
    expect(await encoded.json()).toEqual({ body: { a: "1" } });
  });

  test("answers malformed JSON as the caller's 400", async () => {
    const response = await server.fetch("http://localhost/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  test("leaves a body of an unread content type to the route", async () => {
    const response = await server.fetch("http://localhost/echo", {
      method: "POST",
      headers: { "content-type": "application/x-unknown" },
      body: "x",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  test("a text route reads its body as text whatever the content type", async () => {
    const response = await server.fetch("http://localhost/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"signed":true}',
    });
    expect(await response.json()).toEqual({ body: '{"signed":true}' });
  });
});
