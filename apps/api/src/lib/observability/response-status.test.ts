import { describe, expect, it } from "bun:test";
import { Elysia, status } from "elysia";

import { resolveResponseStatus } from "@/api/lib/observability/response-status";

/**
 * Each way a handler can settle a status, exercised through a real
 * Elysia app: the invariant is that the status observed from
 * `onAfterHandle` is the one the client is actually served, and a
 * hand-built context would only assert what the stand-in was shaped to
 * return rather than what the framework does.
 */
const EXPECTED_STATUS_BY_PATH = {
  "/implicit-ok": 200,
  "/set-status": 202,
  "/set-status-named": 202,
  "/status-helper-4xx": 403,
  "/status-helper-5xx": 500,
  "/status-helper-named": 404,
  "/raw-response": 502,
} as const;

describe("resolveResponseStatus", () => {
  it("reports the status the client is served, however the handler set it", async () => {
    const observed = new Map<string, number>();

    const app = new Elysia()
      .onAfterHandle(({ path, responseValue, set }) => {
        observed.set(
          path,
          resolveResponseStatus({ response: responseValue, set }),
        );
      })
      .get("/implicit-ok", () => ({ ok: true }))
      .get("/set-status", ({ set }) => {
        set.status = 202;
        return { queued: true };
      })
      .get("/set-status-named", ({ set }) => {
        set.status = "Accepted";
        return { queued: true };
      })
      .get("/status-helper-4xx", () => status(403, { code: "forbidden" }))
      .get("/status-helper-5xx", () => status(500, { code: "internal" }))
      .get("/status-helper-named", () => status("Not Found", { code: "gone" }))
      .get("/raw-response", () => new Response("upstream", { status: 502 }));

    const served = new Map<string, number>();
    await Promise.all(
      Object.keys(EXPECTED_STATUS_BY_PATH).map(async (path) => {
        const response = await app.handle(
          new Request(`http://localhost${path}`),
        );
        served.set(path, response.status);
      }),
    );

    // Pins what the framework actually serves, so a change in Elysia's
    // status handling fails here rather than silently redefining the
    // invariant the second assertion checks.
    expect(Object.fromEntries(served)).toEqual(EXPECTED_STATUS_BY_PATH);
    expect(Object.fromEntries(observed)).toEqual(Object.fromEntries(served));
  });
});
