import { describe, expect, test } from "bun:test";

import { createHealthRoute } from "@/api/handlers/health/routes";
import type { ReadinessOutcome } from "@/api/lib/health/readiness";
import { APP_COMMIT_SHA, APP_VERSION } from "@/api/lib/version";

describe("health routes", () => {
  test("liveness and compatibility health do not touch dependencies", async () => {
    let readinessCalls = 0;
    const route = createHealthRoute({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "not-ready", failed: ["database"] };
      },
    });

    const responses = await Promise.all(
      ["live", "health"].map(async (path) => {
        const response = await route.handle(
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
    const route = createHealthRoute({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "not-ready", failed: ["object-storage"] };
      },
    });

    const response = await route.handle(new Request("http://localhost/ready"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      message: "Required dependency unavailable",
    });
    expect(readinessCalls).toBe(1);
  });

  test("turns an unexpected probe rejection into a generic 503", async () => {
    const route = createHealthRoute({
      probeReadiness: async () => {
        throw new Error("private dependency detail");
      },
    });

    const response = await route.handle(new Request("http://localhost/ready"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private dependency detail");
  });
});

describe("startup probe", () => {
  const startedRequest = () => new Request("http://localhost/started");

  test("stays closed until readiness has passed once", async () => {
    const route = createHealthRoute({
      probeReadiness: async () => ({
        status: "not-ready",
        failed: ["database"],
      }),
    });

    const response = await route.handle(startedRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "starting" });
  });

  test("opens after one readiness success and reports build metadata", async () => {
    const route = createHealthRoute({
      probeReadiness: async () => ({ status: "ready" }),
    });

    const response = await route.handle(startedRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "started",
      version: APP_VERSION,
      commit: APP_COMMIT_SHA,
    });
  });

  test("stays open after a later readiness failure", async () => {
    let readiness: ReadinessOutcome = { status: "ready" };
    const route = createHealthRoute({ probeReadiness: async () => readiness });

    expect((await route.handle(startedRequest())).status).toBe(200);
    readiness = { status: "not-ready", failed: ["redis"] };

    const response = await route.handle(startedRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "started" });
  });

  test("does not probe once started", async () => {
    let readinessCalls = 0;
    const route = createHealthRoute({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "ready" };
      },
    });

    await route.handle(startedRequest());
    expect(readinessCalls).toBe(1);
    await route.handle(startedRequest());
    await route.handle(startedRequest());
    expect(readinessCalls).toBe(1);
  });
});
