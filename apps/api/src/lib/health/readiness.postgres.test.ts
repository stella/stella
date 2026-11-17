import { describe, expect, test } from "bun:test";

import { withFakeTimers } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import {
  markScheduledJobsReady,
  probeApiReadiness,
  READINESS_DEPENDENCY,
} from "@/api/lib/health/readiness";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3, FakeS3Options } from "@/api/tests/helpers/fake-s3";

const testState = createTestState({ file: import.meta.path, config: envBase });
const apiState = testState.forConfig(env);
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const markerKey = "system/readiness/v2";

const withReadinessStore = async (
  options: FakeS3Options,
  exercise: (store: FakeS3) => Promise<void>,
): Promise<void> => {
  const redis = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data: (socket, data) => {
        for (const line of data.toString().split("\r\n")) {
          if (line === "HELLO") {
            socket.write("%1\r\n$6\r\nserver\r\n$4\r\nfake\r\n");
          } else if (line === "PING") {
            socket.write("+PONG\r\n");
          }
        }
      },
    },
  });
  const converter = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 200 }),
  });
  const store = startFakeS3(options);
  testState.setConfig("REDIS_URL", `redis://127.0.0.1:${redis.port}`);
  apiState.setConfig(
    "GOTENBERG_URL",
    converter.url.toString().replace(/\/$/u, ""),
  );
  try {
    await exercise(store);
  } finally {
    store.stop();
    redis.stop(true);
    await converter.stop(true);
  }
};

const markerRequests = (store: FakeS3) =>
  store.requests
    .filter(({ key }) => key === markerKey)
    .map(({ method }) => method);

describe.skipIf(!enabled)("the production readiness marker read", () => {
  testState.beforeAll(() => {
    // The dedicated PostgreSQL worker runs the same public startup transition.
    markScheduledJobsReady();
  });

  test.each(["existing-empty", "missing", "nonempty"] as const)(
    "%s marker reaches ready with only the producer's empty payload",
    async (initial) => {
      await withReadinessStore({}, async (store) => {
        if (initial !== "missing") {
          store.put(
            envBase.S3_BUCKET,
            markerKey,
            initial === "nonempty" ? new Uint8Array([42]) : new Uint8Array(),
            "application/octet-stream",
          );
        }
        expect(await probeApiReadiness()).toEqual({ status: "ready" });
        expect(markerRequests(store)).toEqual(
          initial === "existing-empty" ? ["GET"] : ["GET", "PUT", "GET"],
        );
        expect(
          store.objects.get(`${envBase.S3_BUCKET}/${markerKey}`)?.bytes,
        ).toEqual(new Uint8Array());
      });
    },
  );

  test.each(["oversized", "undeclared"] as const)(
    "%s marker responses remain not-ready after the repair attempt",
    async (fault) => {
      await withReadinessStore(
        {
          readResponse: ({ headers }) => {
            const responseHeaders = new Headers(headers);
            if (fault === "oversized") {
              responseHeaders.set("content-length", "1");
              return new Response(new Uint8Array([42]), {
                headers: responseHeaders,
              });
            }
            responseHeaders.delete("content-length");
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array([42]));
                  controller.close();
                },
              }),
              { headers: responseHeaders },
            );
          },
        },
        async (store) => {
          store.put(
            envBase.S3_BUCKET,
            markerKey,
            new Uint8Array(),
            "application/octet-stream",
          );
          expect(await probeApiReadiness()).toEqual({
            status: "not-ready",
            failed: [READINESS_DEPENDENCY.objectStorage],
          });
          expect(markerRequests(store)).toEqual(["GET", "PUT", "GET"]);
        },
      );
    },
  );

  test("a denied marker write stays not-ready", async () => {
    await withReadinessStore({}, async (store) => {
      store.failNext({
        method: "PUT",
        key: markerKey,
        status: 403,
        code: "AccessDenied",
      });
      expect(await probeApiReadiness()).toEqual({
        status: "not-ready",
        failed: [READINESS_DEPENDENCY.objectStorage],
      });
      expect(markerRequests(store)).toEqual(["GET", "PUT"]);
    });
  });

  test("the existing five-second readiness deadline cancels a stalled marker read", async () => {
    await withReadinessStore({}, async (store) => {
      store.put(
        envBase.S3_BUCKET,
        markerKey,
        new Uint8Array(),
        "application/octet-stream",
      );
      const hold = store.holdNext({ method: "GET", keyIncludes: markerKey });
      try {
        await withFakeTimers(async (timers) => {
          const state = { settled: false };
          const outcome = probeApiReadiness().then((result) => {
            state.settled = true;
            return result;
          });
          await hold.reached;
          await timers.advance(4999);
          expect(state.settled).toBe(false);
          await timers.advance(1);
          const result = await outcome;
          expect(result.status).toBe("not-ready");
          if (result.status === "not-ready") {
            expect(result.failed).toContain(READINESS_DEPENDENCY.objectStorage);
          }
        });
        expect(markerRequests(store)).toEqual(["GET"]);
      } finally {
        hold.release();
      }
    });
  });
});
