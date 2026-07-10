import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
  getCurrentRequestId,
  getRequestId,
  initRequestContext,
  REQUEST_ID_HEADER,
  runWithRequestId,
} from "@/api/lib/observability/request-context";

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/u;

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

// Integration: replicate the exact Elysia wiring from src/index.ts (generate the
// id in `onRequest` via `initRequestContext`, stamp it on `set.headers`) using
// the real exported helpers, driven through `app.handle`. Importing the full
// `api` is avoided because its module evaluation mounts better-auth (needs
// DB/env); exercising the helpers here proves the receipt header inside Elysia's
// lifecycle, including that concurrent requests get distinct ids.
const buildReceiptApp = () =>
  new Elysia()
    .onRequest(({ request, set }) => {
      initRequestContext(request);
      const requestId = getRequestId(request);
      if (requestId !== undefined) {
        set.headers[REQUEST_ID_HEADER] = requestId;
      }
    })
    .get("/ping", () => "ok");

describe("x-request-id response header", () => {
  test("every response carries a well-formed receipt id", async () => {
    const app = buildReceiptApp();

    const response = await app.handle(new Request("http://localhost/ping"));

    expect(response.status).toBe(200);
    const header = response.headers.get(REQUEST_ID_HEADER);
    expect(header).toMatch(REQUEST_ID_PATTERN);
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
