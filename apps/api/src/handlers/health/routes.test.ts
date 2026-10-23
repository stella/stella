import { describe, expect, test } from "bun:test";

import { createHealthRoute } from "@/api/handlers/health/routes";
import { createHttpApp } from "@/api/http/app";
import type { ReadinessOutcome } from "@/api/lib/health/readiness";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { APP_COMMIT_SHA, APP_VERSION } from "@/api/lib/version";
import { serveForTest } from "@/api/tests/helpers/test-server";

const serveHealth = (options: Parameters<typeof createHealthRoute>[0]) =>
  serveForTest(
    createHttpApp({
      routes: createHealthRoute(options),
      middleware: [errorBoundary],
    }),
  );

describe("health routes", () => {
  test("liveness and compatibility health do not touch dependencies", async () => {
    let readinessCalls = 0;
    await using server = serveHealth({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "not-ready", failed: ["database"] };
      },
    });

    const responses = await Promise.all(
      ["live", "health"].map(async (path) => {
        const response = await server.fetch(
          new Request(`http://localhost/${path}`),
        );
        return { body: await response.json(), status: response.status };
      }),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: "ok" });
    }
    expect(readinessCalls).toBe(0);
  });

  test("readiness fails closed", async () => {
    let readinessCalls = 0;
    await using server = serveHealth({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "not-ready", failed: ["object-storage"] };
      },
    });

    const response = await server.fetch(new Request("http://localhost/ready"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      message: "Required dependency unavailable",
    });
    expect(readinessCalls).toBe(1);
  });

  test("turns an unexpected probe rejection into a generic 503", async () => {
    await using server = serveHealth({
      probeReadiness: async () => {
        throw new Error("private dependency detail");
      },
    });

    const response = await server.fetch(new Request("http://localhost/ready"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private dependency detail");
  });
});

describe("startup probe", () => {
  const startedRequest = () => new Request("http://localhost/started");

  test("stays closed until readiness has passed once", async () => {
    await using server = serveHealth({
      probeReadiness: async () => ({
        status: "not-ready",
        failed: ["database"],
      }),
    });

    const response = await server.fetch(startedRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "starting" });
  });

  test("opens after one readiness success and reports build metadata", async () => {
    await using server = serveHealth({
      probeReadiness: async () => ({ status: "ready" }),
    });

    const response = await server.fetch(startedRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "started",
      version: APP_VERSION,
      commit: APP_COMMIT_SHA,
    });
  });

  test("stays open after a later readiness failure", async () => {
    let readiness: ReadinessOutcome = { status: "ready" };
    await using server = serveHealth({
      probeReadiness: async () => readiness,
    });

    expect((await server.fetch(startedRequest())).status).toBe(200);
    readiness = { status: "not-ready", failed: ["redis"] };

    const response = await server.fetch(startedRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "started" });
  });

  test("does not probe once started", async () => {
    let readinessCalls = 0;
    await using server = serveHealth({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "ready" };
      },
    });

    await server.fetch(startedRequest());
    expect(readinessCalls).toBe(1);
    await server.fetch(startedRequest());
    await server.fetch(startedRequest());
    expect(readinessCalls).toBe(1);
  });
});
