import { afterAll, describe, expect, test } from "bun:test";
import { setInterval } from "node:timers/promises";

import { REQUEST_ID_HEADER } from "@stll/api-contract";
import { deferred } from "@stll/test-kit";

import { apiPipeline } from "@/api/api-pipeline";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import {
  enrichRequestContext,
  getRequestContext,
  getRequestId,
  openRequestContext,
  runWithRequestId,
} from "@/api/lib/observability/request-context";
import { runWithRequestScope } from "@/api/lib/observability/request-scope";
import { serveForTest } from "@/api/tests/helpers/test-server";

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/u;
const HANDLER_WAIT_MS = 3;
const BACKGROUND_WAIT_MS = 2;
const REQUEST_ROUNDS = 12;

describe("request id ambient store", () => {
  test("no id is active outside a request scope", () => {
    expect(getRequestId()).toBeUndefined();
  });

  test("runWithRequestId binds the ambient id for the callback", () => {
    const seen = runWithRequestId("req_test", () => getRequestId());
    expect(seen).toBe("req_test");
    // Torn down once the callback returns.
    expect(getRequestId()).toBeUndefined();
  });

  test("opening a context outside a request scope is a no-op", () => {
    openRequestContext();
    expect(getRequestContext()).toBeUndefined();
  });
});

describe("request metadata", () => {
  test("keeps the trusted client IP inside the request-scoped context", () => {
    const seen = runWithRequestScope(() => {
      openRequestContext();
      enrichRequestContext({
        clientIp: "192.0.2.1",
        signupRateLimitIp: "198.51.100.1",
      });
      return getRequestContext();
    });

    expect(seen?.clientIp).toBe("192.0.2.1");
    expect(seen?.signupRateLimitIp).toBe("198.51.100.1");
    expect(getRequestContext()).toBeUndefined();
  });
});

// Integration: the production pipeline opens the request scope and the
// receipt id, around a route that waits on a timer as any real handler does:
// the ambient id has to survive an I/O gap, and that gap is where background
// work used to join the scope. Served by a real `Bun.serve`, because the
// failure pinned below only exists on a real event loop.
type ReceiptServerOptions = {
  beforeRequest?: () => Promise<void>;
  waitMs?: number;
};

const createReceiptServer = ({
  beforeRequest,
  waitMs = HANDLER_WAIT_MS,
}: ReceiptServerOptions = {}) =>
  serveForTest(
    createHttpApp({
      middleware: apiPipeline,
      routes: routes({
        "/ping": {
          GET: {
            access: "public",
            config: {},
            run: async () => {
              if (beforeRequest !== undefined) {
                await beforeRequest();
              }
              if (waitMs > 0) {
                // real-time: the ambient id must survive a real I/O gap, which
                // a fake timer or a microtask never opens.
                await Bun.sleep(waitMs);
              }
              return getRequestId() ?? "no-ambient-id";
            },
          },
        },
      }),
    }),
  );

const server = createReceiptServer();

afterAll(async () => {
  await server.stop();
});

describe("x-request-id response header", () => {
  test("every response carries a well-formed receipt id", async () => {
    const response = await server.fetch("http://localhost/ping");

    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(REQUEST_ID_PATTERN);
  });

  test("an unmatched path carries a receipt id too", async () => {
    const response = await server.fetch("http://localhost/nowhere");

    expect(response.status).toBe(404);
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(REQUEST_ID_PATTERN);
  });

  // The ambient id used to be bound with `AsyncLocalStorage.enterWith`, which
  // leaves it on the ambient async context frame, so a background loop
  // resuming there adopted the in-flight request's id and stamped it on
  // unrelated work from then on.
  test.each([0, HANDLER_WAIT_MS])(
    "the ambient id stays isolated with a %ims handler",
    async (waitMs) => {
      const controller = new AbortController();
      const entered = deferred();
      const sampled = deferred();
      const isolatedServer = createReceiptServer({
        waitMs,
        beforeRequest: async () => {
          entered.resolve();
          return sampled.promise;
        },
      });
      const backgroundIds: (string | undefined)[] = [];
      const backgroundLoop = async () => {
        await entered.promise;
        try {
          // real-time: exercise a timer continuation while a request is active.
          for await (const _tick of setInterval(BACKGROUND_WAIT_MS, undefined, {
            signal: controller.signal,
          })) {
            backgroundIds.push(getRequestId());
            sampled.resolve();
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            throw error;
          }
        }
      };
      const background = backgroundLoop();

      const mismatches: string[] = [];
      try {
        for (let round = 0; round < REQUEST_ROUNDS; round += 1) {
          const response = await fetch(new URL("/ping", isolatedServer.url));
          const ambient = await response.text();
          const header = response.headers.get(REQUEST_ID_HEADER);
          if (ambient !== header) {
            mismatches.push(`${header ?? "(no header)"} !== ${ambient}`);
          }
        }
      } finally {
        entered.resolve();
        controller.abort();
        try {
          await background;
        } finally {
          await isolatedServer.stop();
        }
      }

      expect(backgroundIds.length).toBeGreaterThan(0);
      expect(mismatches).toEqual([]);
      expect(backgroundIds.filter((id) => id !== undefined)).toEqual([]);
    },
  );

  test("concurrent requests get distinct receipt ids", async () => {
    const [first, second] = await Promise.all([
      server.fetch("http://localhost/ping"),
      server.fetch("http://localhost/ping"),
    ]);

    const firstId = first.headers.get(REQUEST_ID_HEADER);
    const secondId = second.headers.get(REQUEST_ID_HEADER);
    expect(firstId).toMatch(REQUEST_ID_PATTERN);
    expect(secondId).toMatch(REQUEST_ID_PATTERN);
    expect(firstId).not.toBe(secondId);
    expect(await first.text()).toBe(firstId ?? "");
    expect(await second.text()).toBe(secondId ?? "");
  });
});
