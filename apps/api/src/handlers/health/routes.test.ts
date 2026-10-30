import { describe, expect, test } from "bun:test";

import { DEPLOY_ENV_CONTRACT } from "@/api/deploy-env-contract";
import { envBase } from "@/api/env-base";
import { createHealthRoute } from "@/api/handlers/health/routes";
import { createHttpApp } from "@/api/http/app";
import { API_READINESS_DEPENDENCIES } from "@/api/lib/health/readiness";
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

  test("readiness reports the configured base-environment marker", async () => {
    await using server = serveHealth({
      probeReadiness: async () => ({ status: "ready" }),
    });

    const response = await server.fetch(new Request("http://localhost/ready"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      deployEnvironment: envBase.DEPLOY_ENVIRONMENT ?? null,
    });
    expect(
      DEPLOY_ENV_CONTRACT.flatMap(({ readinessField }) =>
        readinessField === undefined ? [] : [readinessField],
      ),
    ).toEqual(["deployEnvironment"]);
    for (const { readinessField } of DEPLOY_ENV_CONTRACT) {
      if (readinessField !== undefined) {
        expect(body).toHaveProperty(readinessField);
      }
    }
  });

  for (const deployEnvironment of [
    "production",
    "staging",
    undefined,
  ] as const) {
    test(`readiness reports ${String(deployEnvironment)} without changing probe work`, async () => {
      let readinessCalls = 0;
      await using server = serveHealth({
        readDeployEnvironment: () => deployEnvironment,
        probeReadiness: async () => {
          readinessCalls++;
          return { status: "ready" };
        },
      });

      for (let request = 0; request < 2; request++) {
        const response = await server.fetch(
          new Request("http://localhost/ready"),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          status: "ok",
          deployEnvironment: deployEnvironment ?? null,
          version: APP_VERSION,
          commit: APP_COMMIT_SHA,
        });
      }
      expect(readinessCalls).toBe(1);
    });

    test(`unready responses retain the ${String(deployEnvironment)} marker`, async () => {
      await using server = serveHealth({
        readDeployEnvironment: () => deployEnvironment,
        probeReadiness: async () => ({
          status: "not-ready",
          failed: ["database"],
        }),
      });

      const response = await server.fetch(
        new Request("http://localhost/ready"),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: "error",
        deployEnvironment: deployEnvironment ?? null,
      });
    });
  }

  test.each(API_READINESS_DEPENDENCIES)(
    "readiness fails closed while liveness stays open when %s is unavailable",
    async (dependency) => {
      let readinessCalls = 0;
      await using server = serveHealth({
        probeReadiness: async () => {
          readinessCalls++;
          return { status: "not-ready", failed: [dependency] };
        },
      });

      const response = await server.fetch(
        new Request("http://localhost/ready"),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: "error",
        message: "Required dependency unavailable",
      });
      const health = await server.fetch(new Request("http://localhost/health"));
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok" });
      expect(readinessCalls).toBe(1);
    },
  );

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

  test("caches dependency probes while startup is not ready", async () => {
    let readinessCalls = 0;
    await using server = serveHealth({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "not-ready", failed: ["database"] };
      },
    });

    expect((await server.fetch(startedRequest())).status).toBe(503);
    expect((await server.fetch(startedRequest())).status).toBe(503);
    expect(readinessCalls).toBe(1);
  });
});
