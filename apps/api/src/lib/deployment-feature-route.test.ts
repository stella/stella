import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { Middleware, RouteConfig } from "@/api/http/route";
import {
  deploymentFeatureGate,
  deploymentFeatureGateFlag,
  localDevelopmentGate,
} from "@/api/lib/deployment-feature-route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";

const FLAG = "FEATURE_SHAREPOINT";

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => await server.stop()),
  );
});

/** A route behind `gate` and the production error boundary. */
const serveGated = (
  gate: Middleware,
  config: RouteConfig,
  onRun: () => void = () => undefined,
): TestServer => {
  const server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes(
        {
          "/feature": {
            GET: defineEndpoint.public(config, () => {
              onRun();
              return { ok: true };
            }),
          },
        },
        { middleware: [gate] },
      ),
    }),
  );
  servers.push(server);
  return server;
};

const gateFor = (enabled: boolean) =>
  deploymentFeatureGate(FLAG, { isEnabled: () => enabled });

const strictQuery = {
  query: v.object({ q: v.pipe(v.string(), v.minLength(1)) }),
} satisfies RouteConfig;

describe("deploymentFeatureGate", () => {
  test("returns 404 without executing a disabled route", async () => {
    let executed = false;
    const server = serveGated(gateFor(false), {}, () => {
      executed = true;
    });

    const response = await server.fetch("http://localhost/feature");

    expect(response.status).toBe(404);
    expect(executed).toBe(false);
  });

  test("answers a disabled route exactly as an absent one", async () => {
    const server = serveGated(gateFor(false), {});

    const disabled = await server.fetch("http://localhost/feature");
    const absent = await server.fetch("http://localhost/nowhere");

    expect(disabled.status).toBe(absent.status);
    expect(await disabled.text()).toBe(await absent.text());
  });

  test("answers 404, not a validation error, for a malformed request", async () => {
    const server = serveGated(gateFor(false), strictQuery);

    const response = await server.fetch("http://localhost/feature");

    expect(response.status).toBe(404);
  });

  test("leaves an enabled route runnable and still validating", async () => {
    const server = serveGated(gateFor(true), strictQuery);

    const valid = await server.fetch("http://localhost/feature?q=x");
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ ok: true });

    const malformed = await server.fetch("http://localhost/feature");
    expect(malformed.status).toBe(422);
  });

  test("reads the flag on every request, not once at mount", async () => {
    let enabled = false;
    let reads = 0;
    const server = serveGated(
      deploymentFeatureGate(FLAG, {
        isEnabled: () => {
          reads += 1;
          return enabled;
        },
      }),
      {},
    );
    expect(reads).toBe(0);

    expect((await server.fetch("http://localhost/feature")).status).toBe(404);
    enabled = true;
    expect((await server.fetch("http://localhost/feature")).status).toBe(200);
    enabled = false;
    expect((await server.fetch("http://localhost/feature")).status).toBe(404);
    expect(reads).toBe(3);
  });

  test("names the flag it stands for, and nothing for other middleware", () => {
    expect(deploymentFeatureGateFlag(gateFor(true))).toBe(FLAG);
    expect(deploymentFeatureGateFlag(deploymentFeatureGate(FLAG))).toBe(FLAG);
    expect(deploymentFeatureGateFlag(localDevelopmentGate)).toBeUndefined();
    expect(deploymentFeatureGateFlag(errorBoundary)).toBeUndefined();
  });
});
