import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createHttpApp } from "@/api/http/app";
import type { RequestContext } from "@/api/http/context";
import { HTTP_FAILURE, HttpFailureError } from "@/api/http/errors";
import { routes } from "@/api/http/route";
import type { Middleware, RouteConfig } from "@/api/http/route";
import {
  deploymentFeatureGate,
  deploymentFeatureGateExcept,
  deploymentFeatureGateFlag,
  localDevelopmentGate,
} from "@/api/lib/deployment-feature-route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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

describe("deploymentFeatureGateExcept", () => {
  const ADMITTED = '{"type":"exception"}';
  const gate = deploymentFeatureGateExcept(
    FLAG,
    { maxBytes: 64, admits: (body) => body === ADMITTED },
    { isEnabled: () => false },
  );
  /** Runs the disabled gate over `body`; `inner` records the request it got. */
  const pass = async (body: string | ReadableStream<Uint8Array>) => {
    const received: string[] = [];
    // The refusal is thrown for the error boundary to answer.
    const thrown = await gate(
      asTestRaw<RequestContext>({
        request: new Request("http://localhost/feature", {
          method: "PUT",
          body,
        }),
      }),
      async (replacement) => {
        received.push((await replacement?.request.text()) ?? "");
        return new Response(null, { status: 204 });
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    return { thrown, received };
  };

  test("hands the route the admitted body it read", async () => {
    const { thrown, received } = await pass(ADMITTED);

    expect(thrown).toBeNull();
    expect(received).toEqual([ADMITTED]);
  });

  test("answers an absent route when the body cannot be read", async () => {
    const encoder = new TextEncoder();
    const cutOff = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type"'));
        controller.error(new Error("The upload was cut off"));
      },
    });

    const { thrown, received } = await pass(cutOff);

    expect(received).toEqual([]);
    expect(thrown).toBeInstanceOf(HttpFailureError);
    expect(thrown).toMatchObject({ kind: HTTP_FAILURE.notFound });
  });
});
