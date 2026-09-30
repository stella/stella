import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { resolveClientAddress } from "@/api/lib/client-ip";

import {
  ActionSizeError,
  getTenantActionSizePolicy,
} from "./action-size-limits";
import {
  createTenantActionClassifier,
  runTenantHttpAction,
  TENANT_ACTION_DETAIL,
} from "./tenant-action-boundary";

const tenantHooks = {
  detail: { summary: "Tenant action fixture", [TENANT_ACTION_DETAIL]: true },
};
const limits = { requestBytes: 8, responseBytes: 512, pageSize: 3 };
const bytes = new TextEncoder();

describe("tenant route classification", () => {
  for (const aot of [true, false]) {
    for (const strictPath of [true, false]) {
      test(`matches framework dispatch without running handlers (aot=${aot}, strict=${strictPath})`, async () => {
        let dispatched = 0;
        const tenant = () => {
          dispatched += 1;
          return "tenant";
        };
        const exempt = () => {
          dispatched += 1;
          return "exempt";
        };
        const app = new Elysia({ aot, strictPath })
          .all("/fixed", exempt)
          .get("/:id", tenant, tenantHooks)
          .post("/write", tenant, tenantHooks)
          .get("/public/*", exempt)
          .get("/tenant/*", tenant, tenantHooks)
          .get("/encoded space", tenant, tenantHooks)
          .get("/optional/:id?", tenant, tenantHooks);
        const classify = createTenantActionClassifier({
          routes: app.routes,
          staticRoutes: app.router.static,
          strictPath: app.config.strictPath,
          aot: app.config.aot,
        });
        const cases = [
          ["GET", "/fixed"],
          ["POST", "/fixed"],
          ["DELETE", "/fixed"],
          ["GET", "/fixed/"],
          ["GET", "/value"],
          ["POST", "/value"],
          ["POST", "/write"],
          ["POST", "/write/"],
          ["GET", "/write"],
          ["GET", "/public/a/b"],
          ["POST", "/public/a/b"],
          ["GET", "/tenant/a/b"],
          ["GET", "/encoded%20space"],
          ["GET", "/encoded%20space/"],
          ["GET", "/optional"],
          ["GET", "/optional/item"],
          ["GET", "/optional/item/"],
          ["GET", "/tenant/a%2Fb?ignored=1"],
          ["DELETE", "/missing"],
        ] as const;
        expect(dispatched).toBe(0);
        for (const [method, path] of cases) {
          const request = new Request(`http://localhost${path}`, { method });
          const before = dispatched;
          const decision = classify(request);
          expect(dispatched).toBe(before);
          const response = await app.handle(request);
          expect(decision).toBe(
            response.status === 200 && (await response.text()) === "tenant",
          );
        }
        // AOT's static ALL route precedes dynamic GET; dynamic dispatch reverses it.
        expect(classify(new Request("http://localhost/fixed"))).toBe(!aot);
        for (const upgrade of ["websocket", "WebSocket"]) {
          const request = new Request("http://localhost/value", {
            headers: { upgrade },
          });
          const response = await app.handle(request);
          expect(classify(request)).toBe(
            response.status === 200 && (await response.text()) === "tenant",
          );
        }
      });
    }
  }

  test("derives upgrade dispatch from the same static and dynamic websocket registry", async () => {
    for (const aot of [true, false]) {
      const app = new Elysia({ aot })
        .get("/socket", () => "tenant", tenantHooks)
        .route("WS", "/socket", () => "exempt")
        .get("/live/:id", () => "tenant", tenantHooks)
        .route("WS", "/live/:id", () => "exempt");
      const classify = createTenantActionClassifier({
        routes: app.routes,
        staticRoutes: app.router.static,
        strictPath: app.config.strictPath,
        aot: app.config.aot,
      });
      for (const path of ["/socket", "/live/item"]) {
        for (const upgrade of [undefined, "websocket", "WebSocket"]) {
          const headers = new Headers();
          if (upgrade !== undefined) {
            headers.set("upgrade", upgrade);
          }
          const request = new Request(`http://localhost${path}`, { headers });
          const response = await app.handle(request);
          expect(classify(request)).toBe(
            response.status === 200 && (await response.text()) === "tenant",
          );
        }
      }
    }
  });

  test("preserves the first static path group's ownership of colliding loose aliases", async () => {
    for (const reverse of [false, true]) {
      const app = new Elysia({ aot: true, strictPath: false });
      if (reverse) {
        app
          .post("/same/", () => "exempt")
          .all("/same", () => "tenant", tenantHooks);
      } else {
        app
          .all("/same", () => "tenant", tenantHooks)
          .post("/same/", () => "exempt");
      }
      const classify = createTenantActionClassifier({
        routes: app.routes,
        staticRoutes: app.router.static,
        strictPath: app.config.strictPath,
        aot: app.config.aot,
      });
      for (const path of ["/same", "/same/"]) {
        for (const method of ["GET", "POST"]) {
          const request = new Request(`http://localhost${path}`, { method });
          const response = await app.handle(request);
          expect({
            reverse,
            path,
            method,
            classified: classify(request),
          }).toEqual({
            reverse,
            path,
            method,
            classified:
              response.status === 200 && (await response.text()) === "tenant",
          });
        }
      }
    }
  });
});

describe("tenant HTTP action boundary", () => {
  test("disabled and anonymous actions preserve the request and response without reading limits", async () => {
    for (const mode of ["disabled", "anonymous"] as const) {
      const request = new Request("http://localhost/public", {
        method: "POST",
        body: "oversized payload",
      });
      const response = Response.json({ unchanged: "😀" });
      let classifications = 0;
      let policyReads = 0;
      const result = await runTenantHttpAction(request, {
        enabled: mode !== "disabled",
        isTenantAction: () => {
          classifications += 1;
          return false;
        },
        policy: () => {
          policyReads += 1;
          return Result.ok(limits);
        },
        handleRequest: (received) => {
          expect(received).toBe(request);
          expect(getTenantActionSizePolicy()).toBeUndefined();
          return response;
        },
      });
      expect(result).toBe(response);
      expect(policyReads).toBe(0);
      expect(classifications).toBe(mode === "disabled" ? 0 : 1);
      expect(request.bodyUsed).toBe(false);
      expect(response.bodyUsed).toBe(false);
    }
  });

  test("rejects actual oversized bodies before authentication or handler work and decorates refusals", async () => {
    let authCalls = 0;
    let workCalls = 0;
    const app = new Elysia()
      .onRequest(() => {
        authCalls += 1;
      })
      .post("/action", () => {
        workCalls += 1;
        return { success: true };
      });
    const request = new Request("http://localhost/action", {
      method: "POST",
      body: "😀😀😀",
      headers: { "content-length": "1" },
    });
    const response = await runTenantHttpAction(request, {
      enabled: true,
      isTenantAction: () => true,
      policy: () => Result.ok(limits),
      handleRequest: (received) => app.handle(received),
      decorateRefusal: (refusal, original) => {
        expect(original).toBe(request);
        refusal.headers.set(
          "access-control-allow-origin",
          "https://example.test",
        );
        return refusal;
      },
    });
    expect(response.status).toBe(413);
    expect(authCalls).toBe(0);
    expect(workCalls).toBe(0);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://example.test",
    );
  });

  test("invalid enabled configuration refuses before reading the body or dispatching", async () => {
    const request = new Request("http://localhost/action", {
      method: "POST",
      body: "body",
    });
    let dispatched = 0;
    const response = await runTenantHttpAction(request, {
      enabled: true,
      isTenantAction: () => true,
      policy: () =>
        Result.err(
          new ActionSizeError({
            message: "Invalid size limits",
            reason: "configuration",
          }),
        ),
      handleRequest: () => {
        dispatched += 1;
        return Response.json({ success: true });
      },
    });
    expect(response.status).toBe(503);
    expect(dispatched).toBe(0);
    expect(request.bodyUsed).toBe(false);
  });

  test("preserves exact UTF-8 request bytes and tenant policy through asynchronous framework execution", async () => {
    const body = "😀😀";
    const request = new Request("http://localhost/action", {
      method: "POST",
      body,
    });
    const response = await runTenantHttpAction(request, {
      enabled: true,
      isTenantAction: () => true,
      policy: () => Result.ok(limits),
      handleRequest: async (received) => {
        expect(received).toBe(request);
        expect(received.headers.get("content-length")).toBe("8");
        expect(await received.text()).toBe(body);
        expect(getTenantActionSizePolicy()).toBe(limits);
        return Response.json({ body });
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body });
    expect(getTenantActionSizePolicy()).toBeUndefined();
  });

  test("retains the native peer address while metering accepted bodies", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, nativeServer) =>
        await runTenantHttpAction(request, {
          enabled: true,
          isTenantAction: () => true,
          policy: () => Result.ok(limits),
          handleRequest: async (received) => {
            const address = resolveClientAddress(received, nativeServer);
            return Response.json({
              address: address?.address,
              body: await received.text(),
            });
          },
        }),
    });
    try {
      const response = await fetch(server.url, { method: "POST", body: "é" });
      expect(await response.json()).toEqual({
        address: "127.0.0.1",
        body: "é",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("retains successful mutation statuses, headers and whole bodies above the response ceiling", async () => {
    const payload = { result: "é".repeat(300) };
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      let applied = 0;
      const response = await runTenantHttpAction(
        new Request("http://localhost/action", { method }),
        {
          enabled: true,
          isTenantAction: () => true,
          policy: () => Result.ok(limits),
          handleRequest: () => {
            applied += 1;
            return Response.json(payload, {
              status: 201,
              headers: { "x-request-id": "completed-action" },
            });
          },
        },
      );
      expect(applied).toBe(1);
      expect(response.status).toBe(201);
      expect(response.headers.get("x-request-id")).toBe("completed-action");
      expect(await response.json()).toEqual(payload);
    }
  });

  test("bounds whole serialized JSON bytes after framework encoding and preserves SSE", async () => {
    const payload = { text: "😀é", nested: { escaped: '\\"\n' } };
    const serialized = JSON.stringify(payload);
    const exactBytes = bytes.encode(serialized).byteLength;
    let handlerCalls = 0;
    const app = new Elysia().get("/action", () => {
      handlerCalls += 1;
      return payload;
    });
    for (const responseBytes of [exactBytes, exactBytes - 1]) {
      const response = await runTenantHttpAction(
        new Request("http://localhost/action"),
        {
          enabled: true,
          isTenantAction: () => true,
          policy: () => Result.ok({ ...limits, responseBytes }),
          handleRequest: (request) => app.handle(request),
        },
      );
      expect(response.status).toBe(responseBytes === exactBytes ? 200 : 413);
      if (response.status === 200) {
        expect(await response.text()).toBe(serialized);
      }
    }
    expect(handlerCalls).toBe(2);
    const eventStream = new Response("data: 😀😀😀\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const response = await runTenantHttpAction(
      new Request("http://localhost/action"),
      {
        enabled: true,
        isTenantAction: () => true,
        policy: () => Result.ok({ ...limits, responseBytes: 1 }),
        handleRequest: () => eventStream,
      },
    );
    expect(response).toBe(eventStream);
    expect(eventStream.bodyUsed).toBe(false);
  });
});
