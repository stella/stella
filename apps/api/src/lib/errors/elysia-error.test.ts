import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";

import { elysiaErrorAnswer } from "@/api/lib/errors/elysia-error";
import { httpError } from "@/api/lib/errors/http-error";

// A body whose declared type matches the response schema and whose runtime
// value does not: the drift a response schema exists to catch, and the only
// way to reach it here, since the compiler rejects a literal mismatch.
const driftedBody = (): { ok: string } => JSON.parse('{"unexpected":true}');

// A real Elysia app, so the answers stay bound to the errors the framework
// actually raises rather than to a hand-written stand-in for them.
const app = new Elysia()
  .onError(({ code, error, set }) => {
    const { status, message } = elysiaErrorAnswer(code, error);
    set.status = status;
    return httpError(message);
  })
  .post("/typed-body", () => "ok", {
    body: t.Object({ name: t.String() }),
  })
  .get("/typed-response", () => driftedBody(), {
    response: t.Object({ ok: t.String() }),
  })
  .get("/throws", () => {
    throw new Error("boom");
  });

const post = async (path: string, body: string) =>
  await app.handle(
    new Request(`http://localhost${path}`, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

const get = async (path: string) =>
  await app.handle(new Request(`http://localhost${path}`));

describe("answering a framework-raised error", () => {
  test("a body that does not match its schema is the caller's to fix", async () => {
    const response = await post("/typed-body", JSON.stringify({ name: 42 }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ message: "Invalid request" });
  });

  test("a handler output that does not match its response schema is a server fault", async () => {
    const response = await get("/typed-response");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: "Internal server error",
    });
  });

  test("an unparseable body is answered as a malformed request", async () => {
    const response = await post("/typed-body", "{");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Malformed request" });
  });

  test("an unrouted path is answered as not found", async () => {
    const response = await get("/nowhere");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Not found" });
  });

  test("an error raised inside a handler is answered as a server fault", async () => {
    const response = await get("/throws");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: "Internal server error",
    });
  });

  test("no message from a rejected value reaches the answer", async () => {
    const rejected = "client-supplied-value";
    const response = await post(
      "/typed-body",
      JSON.stringify({ name: [rejected] }),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain(rejected);
  });
});
