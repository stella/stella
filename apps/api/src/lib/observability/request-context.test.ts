import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
  enrichRequestContext,
  getCurrentRequestId,
  getRequestContext,
  getRequestId,
  initRequestContext,
  REQUEST_ID_HEADER,
  runWithRequestId,
} from "@/api/lib/observability/request-context";
import { runWithRequestScope } from "@/api/lib/observability/request-scope";

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/u;
const HANDLER_WAIT_MS = 3;
const BACKGROUND_WAIT_MS = 2;
const REQUEST_ROUNDS = 12;

describe("request id ambient store", () => {
  test("no id is active outside a request scope", () => {
    expect(getCurrentRequestId()).toBeUndefined();
  });

  test("runWithRequestId binds the ambient id for the callback", () => {
    const seen = runWithRequestId("req_test", () => getCurrentRequestId());
    expect(seen).toBe("req_test");
    // Torn down once the callback returns.
    expect(getCurrentRequestId()).toBeUndefined();
  });
});

describe("request metadata", () => {
  test("keeps the trusted client IP inside the request-scoped context", () => {
    const request = new Request("http://localhost/ping");
    initRequestContext(request);
    enrichRequestContext(request, {
      clientIp: "192.0.2.1",
      signupRateLimitIp: "198.51.100.1",
    });

    expect(getRequestContext(request)?.clientIp).toBe("192.0.2.1");
    expect(getRequestContext(request)?.signupRateLimitIp).toBe("198.51.100.1");
  });
});

// Integration: replicate the exact Elysia wiring from server.ts (`wrap` opens
// the request scope, `onRequest` generates the id via `initRequestContext` and
// stamps it on `set.headers`) using the real exported helpers. Importing the
// full `api` is avoided because its module evaluation mounts better-auth (needs
// DB/env); exercising the helpers here proves the receipt header inside
// Elysia's lifecycle, including that concurrent requests get distinct ids.
const buildReceiptApp = () =>
  new Elysia()
    .wrap(
      (handleRequest) => (request: Request) =>
        runWithRequestScope(() => handleRequest(request)),
    )
    .onRequest(({ request, set }) => {
      initRequestContext(request);
      const requestId = getRequestId(request);
      if (requestId !== undefined) {
        set.headers[REQUEST_ID_HEADER] = requestId;
      }
    })
    // Waits on a timer, as any real handler does: the ambient id has to survive
    // an I/O gap, and that gap is where background work used to join the scope.
    .get("/ping", async () => {
      await Bun.sleep(HANDLER_WAIT_MS);
      return getCurrentRequestId() ?? "no-ambient-id";
    });

describe("x-request-id response header", () => {
  test("every response carries a well-formed receipt id", async () => {
    const app = buildReceiptApp();

    const response = await app.handle(new Request("http://localhost/ping"));

    expect(response.status).toBe(200);
    const header = response.headers.get(REQUEST_ID_HEADER);
    expect(header).toMatch(REQUEST_ID_PATTERN);
  });

  // Over a real listener, because the failure this pins only exists on a real
  // event loop: the ambient id used to be bound with
  // `AsyncLocalStorage.enterWith`, which leaves it on the ambient async context
  // frame, so a background loop resuming there adopted the in-flight request's
  // id and stamped it on unrelated work from then on.
  test("the ambient id belongs to its own request and never to background work", async () => {
    const signal = { done: false };
    const backgroundIds: (string | undefined)[] = [];
    const backgroundLoop = async () => {
      while (!signal.done) {
        await Bun.sleep(BACKGROUND_WAIT_MS);
        backgroundIds.push(getCurrentRequestId());
      }
    };
    void backgroundLoop();

    const app = buildReceiptApp().listen({ port: 0 });
    const origin = `http://localhost:${app.server?.port}`;
    const mismatches: string[] = [];
    for (let round = 0; round < REQUEST_ROUNDS; round += 1) {
      const response = await fetch(`${origin}/ping`);
      const ambient = await response.text();
      const header = response.headers.get(REQUEST_ID_HEADER);
      if (ambient !== header) {
        mismatches.push(`${header} !== ${ambient}`);
      }
    }

    signal.done = true;
    await app.stop();

    expect(mismatches).toEqual([]);
    expect(backgroundIds.filter((id) => id !== undefined)).toEqual([]);
  });

  test("concurrent requests get distinct receipt ids", async () => {
    const app = buildReceiptApp();

    const [first, second] = await Promise.all([
      app.handle(new Request("http://localhost/ping")),
      app.handle(new Request("http://localhost/ping")),
    ]);

    const firstId = first.headers.get(REQUEST_ID_HEADER);
    const secondId = second.headers.get(REQUEST_ID_HEADER);
    expect(firstId).toMatch(REQUEST_ID_PATTERN);
    expect(secondId).toMatch(REQUEST_ID_PATTERN);
    expect(firstId).not.toBe(secondId);
  });
});
