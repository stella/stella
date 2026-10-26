import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { apiPipeline } from "@/api/api-pipeline";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import type { HttpApp } from "@/api/http/app";
import { cors } from "@/api/http/cors";
import { routes } from "@/api/http/route";
import type {
  Middleware,
  RouteAccess,
  RouteDefinition,
  RouteEntry,
  RouteRequest,
} from "@/api/http/route";
import { resolveClientAddress } from "@/api/lib/client-ip";
import { sendServedRequest } from "@/api/tests/helpers/served-request";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";
import { createTestState } from "@/api/tests/helpers/test-state";

import {
  ActionSizeError,
  getTenantActionSizePolicy,
} from "./action-size-limits";
import type { ActionSizePolicy } from "./action-size-limits";
import {
  isTenantAction,
  tenantActionAdmission,
} from "./tenant-action-boundary";

const testState = createTestState({ file: import.meta.path, config: env });

const limits = { requestBytes: 8, responseBytes: 512, pageSize: 3 };
const bytes = new TextEncoder();

const definition = (
  access: RouteAccess,
  answer: (request: RouteRequest) => unknown,
): RouteDefinition => ({
  access,
  config: {},
  run: async (request) => await answer(request),
});

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => await server.stop()),
  );
});

const serve = (app: HttpApp): TestServer => {
  const server = serveForTest(app);
  servers.push(server);
  return server;
};

type AdmissionOptions = {
  readonly enabled?: boolean;
  readonly policy?: () => Result<ActionSizePolicy | undefined, ActionSizeError>;
  readonly outer?: readonly Middleware[];
  readonly inner?: readonly Middleware[];
};

const admissionApp = (
  table: Parameters<typeof routes>[0],
  {
    enabled = true,
    policy = () => Result.ok(limits),
    outer = [],
    inner = [],
  }: AdmissionOptions = {},
): HttpApp =>
  createHttpApp({
    middleware: [
      ...outer,
      tenantActionAdmission({ enabled: () => enabled, policy }),
      ...inner,
    ],
    routes: routes(table),
  });

describe("tenant route classification", () => {
  const entryWith = (access: RouteAccess): RouteEntry => ({
    method: "GET",
    path: "/fixture",
    middleware: [],
    definition: definition(access, () => "ok"),
  });

  test.each([
    ["member", true],
    ["workspace", true],
    ["session", false],
    ["token", false],
    ["public", false],
  ] as const)("a %s route is a tenant action: %p", (access, expected) => {
    expect(isTenantAction(entryWith(access))).toBe(expected);
  });

  test("a request no route serves is no tenant action", () => {
    expect(isTenantAction(undefined)).toBe(false);
  });

  test("the route the router matched decides, not the path", async () => {
    const answer = () => ({ value: "é".repeat(300) });
    const server = serve(
      admissionApp({
        "/items/:id": { GET: definition("member", answer) },
        "/items/public": { GET: definition("public", answer) },
      }),
    );

    const tenant = await server.fetch("http://localhost/items/item-1");
    const exempt = await server.fetch("http://localhost/items/public");

    expect(tenant.status).toBe(413);
    expect(exempt.status).toBe(200);
    expect(await exempt.json()).toEqual(answer());
  });
});

describe("tenant HTTP action boundary", () => {
  test("disabled and anonymous actions pass the request and response through without reading limits", async () => {
    for (const mode of ["disabled", "anonymous"] as const) {
      let policyReads = 0;
      const seen: { policy: ActionSizePolicy | undefined; body: string }[] = [];
      const route = definition(
        mode === "disabled" ? "member" : "public",
        async ({ ctx }) => {
          seen.push({
            policy: getTenantActionSizePolicy(),
            body: await ctx.request.text(),
          });
          return { unchanged: "😀".repeat(200) };
        },
      );
      const app = admissionApp(
        { "/action": { POST: route } },
        {
          enabled: mode !== "disabled",
          policy: () => {
            policyReads += 1;
            return Result.ok(limits);
          },
        },
      );

      const response = await sendServedRequest(app, {
        path: "/action",
        body: "oversized payload",
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        unchanged: "😀".repeat(200),
      });
      expect(policyReads).toBe(0);
      expect(seen).toEqual([{ policy: undefined, body: "oversized payload" }]);
    }
  });

  test("rejects actual oversized bodies before authentication or handler work, and outer stages still answer", async () => {
    let authCalls = 0;
    let workCalls = 0;
    const authentication: Middleware = async (_ctx, inner) => {
      authCalls += 1;
      return await inner();
    };
    const server = serve(
      admissionApp(
        {
          "/action": {
            POST: definition("member", () => {
              workCalls += 1;
              return { success: true };
            }),
          },
        },
        {
          outer: [
            cors({
              isAllowedOrigin: (origin) => origin === "https://example.test",
              methods: ["POST"],
              allowedHeaders: [],
              exposedHeaders: [],
              maxAgeSeconds: 60,
            }),
          ],
          inner: [authentication],
        },
      ),
    );

    const response = await server.fetch("http://localhost/action", {
      method: "POST",
      body: "😀😀😀",
      headers: { "content-length": "1", origin: "https://example.test" },
    });

    expect(response.status).toBe(413);
    expect(authCalls).toBe(0);
    expect(workCalls).toBe(0);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://example.test",
    );
  });

  test("invalid enabled configuration refuses before dispatching", async () => {
    let dispatched = 0;
    const server = serve(
      admissionApp(
        {
          "/action": {
            POST: definition("member", () => {
              dispatched += 1;
              return { success: true };
            }),
          },
        },
        {
          policy: () =>
            Result.err(
              new ActionSizeError({
                message: "Invalid size limits",
                reason: "configuration",
              }),
            ),
        },
      ),
    );

    const response = await server.fetch("http://localhost/action", {
      method: "POST",
      body: "body",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "service_unavailable",
      message: "Invalid size limits",
    });
    expect(dispatched).toBe(0);
  });

  test("preserves exact UTF-8 request bytes and the tenant policy through the route", async () => {
    const body = "😀😀";
    const app = admissionApp({
      "/action": {
        POST: definition("member", async ({ ctx }) => ({
          contentLength: ctx.request.headers.get("content-length"),
          body: await ctx.request.text(),
          policy: getTenantActionSizePolicy() === limits,
        })),
      },
    });

    const response = await sendServedRequest(app, { path: "/action", body });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      contentLength: "8",
      body,
      policy: true,
    });
    expect(getTenantActionSizePolicy()).toBeUndefined();
  });

  test("resolves the sealed peer address behind the production pipeline after re-framing the body", async () => {
    testState.setConfig("FEATURE_ACTION_ADMISSION", true);
    testState.setConfig("ACTION_REQUEST_MAX_BYTES", limits.requestBytes);
    testState.setConfig("ACTION_RESPONSE_MAX_BYTES", limits.responseBytes);
    testState.setConfig("ACTION_PAGE_SIZE_MAX", limits.pageSize);
    const app = createHttpApp({
      middleware: apiPipeline,
      routes: routes({
        "/": {
          POST: definition("member", async ({ ctx }) => ({
            address: resolveClientAddress(ctx.request, ctx.server)?.address,
            body: await ctx.request.text(),
            contentLength: ctx.request.headers.get("content-length"),
          })),
        },
      }),
    });
    // Served on IPv4 loopback, so the peer is not reported as a mapped address.
    const response = await sendServedRequest(app, { path: "/", body: "é" });
    expect(JSON.parse(response.body)).toEqual({
      address: "127.0.0.1",
      body: "é",
      contentLength: "2",
    });
  });

  test("retains successful mutation statuses, headers and whole bodies above the response ceiling", async () => {
    const payload = { result: "é".repeat(300) };
    let applied = 0;
    const mutation = definition("member", () => {
      applied += 1;
      return Response.json(payload, {
        status: 201,
        headers: { "x-request-id": "completed-action" },
      });
    });
    const server = serve(
      admissionApp({
        "/action": {
          POST: mutation,
          PUT: mutation,
          PATCH: mutation,
          DELETE: mutation,
        },
      }),
    );
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await server.fetch("http://localhost/action", {
        method,
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("x-request-id")).toBe("completed-action");
      expect(await response.json()).toEqual(payload);
    }
    expect(applied).toBe(4);
  });

  test("bounds whole serialized JSON bytes after encoding and preserves event streams", async () => {
    const payload = { text: "😀é", nested: { escaped: '\\"\n' } };
    const serialized = JSON.stringify(payload);
    const exactBytes = bytes.encode(serialized).byteLength;
    let handlerCalls = 0;
    let responseBytes = exactBytes;
    const server = serve(
      admissionApp(
        {
          "/action": {
            GET: definition("member", () => {
              handlerCalls += 1;
              return payload;
            }),
          },
          "/events": {
            GET: definition(
              "member",
              () =>
                new Response("data: 😀😀😀\n\n", {
                  headers: { "content-type": "text/event-stream" },
                }),
            ),
          },
        },
        { policy: () => Result.ok({ ...limits, responseBytes }) },
      ),
    );
    for (const ceiling of [exactBytes, exactBytes - 1]) {
      responseBytes = ceiling;
      const response = await server.fetch("http://localhost/action");
      expect(response.status).toBe(ceiling === exactBytes ? 200 : 413);
      if (response.status === 200) {
        expect(await response.text()).toBe(serialized);
      }
    }
    expect(handlerCalls).toBe(2);

    responseBytes = 1;
    const stream = await server.fetch("http://localhost/events");
    expect(stream.status).toBe(200);
    expect(await stream.text()).toBe("data: 😀😀😀\n\n");
  });
});
