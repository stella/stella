import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import { createHttpApp } from "@/api/http/app";
import type { Middleware } from "@/api/http/route";
import { toSafeId } from "@/api/lib/branded-types";
import {
  getRequestFailure,
  runWithRequestId,
} from "@/api/lib/observability/request-context";
import { MCP_ALL_RESOURCE_SCOPES } from "@/api/mcp/constants";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { sendServedRequest } from "@/api/tests/helpers/served-request";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("served_org");
const userId = toSafeId<"user">("served_user");

type HandlerDependencies = Parameters<typeof createMcpHttpRequestHandler>[0];

const handlerWith = (overrides: Partial<HandlerDependencies> = {}) =>
  createMcpHttpRequestHandler({
    actionSizePolicy: () =>
      Result.ok({
        requestBytes: 1_048_576,
        responseBytes: 1_048_576,
        pageSize: 100,
      }),
    authenticateMcpRequest: async () =>
      Result.ok({
        organizationId,
        userId,
        scopes: [...MCP_ALL_RESOURCE_SCOPES],
      }),
    captureError: () => undefined,
    getMcpToolDefinition: async () => undefined,
    getMcpToolRequiredScopesHint: () => undefined,
    handleMcpToolCall: async () => ({ content: [] }),
    listMcpTools: async () => [],
    listMcpResources: async () => [],
    readMcpResource: () => ({ contents: [] }),
    recordMcpSessionInitialized: () => undefined,
    resolveMcpSessionContext: async () =>
      asTestRaw<AuthorizedMcpRequestContext>({ organizationId, userId }),
    ...overrides,
  });

const initializeBody = JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "served-body-test", version: "1.0.0" },
    protocolVersion: "2025-06-18",
  },
});

// The awaited stages a production request passes before the transport
// touches its body; by then a body sent with its headers has fully arrived.
const awaitedStage: Middleware = async (_ctx, inner) => {
  // real-time: only a real I/O gap lets the body arrive in full before the
  // transport reads it, the state under test.
  await Bun.sleep(5);
  return await inner();
};

describe("MCP over a served socket", () => {
  test("answers initialize when the bounded body arrived with its headers", async () => {
    const observeTransportFailure = mock();
    const app = createHttpApp({
      routes: createMcpRoute({
        handleMcpHttpRequest: handlerWith({
          observeTransportFailure: (error, context) => {
            observeTransportFailure(error, context);
          },
        }),
      }),
      middleware: [awaitedStage],
    });
    const response = await sendServedRequest(app, {
      path: "/mcp",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
      body: initializeBody,
    });
    expect({
      status: response.status,
      observed: observeTransportFailure.mock.calls,
    }).toEqual({ status: 200, observed: [] });
    expect(JSON.parse(response.body)).toMatchObject({
      id: 1,
      jsonrpc: "2.0",
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: expect.any(String) },
      },
    });
  });

  test("a transport fault answers 503 and is observed with its cause", async () => {
    const error = new Error("token verification crashed");
    const request = () =>
      new Request("http://localhost/mcp", {
        body: initializeBody,
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer token",
          "content-type": "application/json",
        },
        method: "POST",
      });
    const authenticateMcpRequest = async () => await Promise.reject(error);

    const observeTransportFailure = mock();
    const injected = await handlerWith({
      authenticateMcpRequest,
      observeTransportFailure: (failure, context) => {
        observeTransportFailure(failure, context);
      },
    })(request());
    expect(injected.status).toBe(503);
    expect(observeTransportFailure.mock.calls).toEqual([
      [error, { mode: "default", request: expect.any(Request) }],
    ]);

    // The production observer records the failure on the request scope, so
    // the request's completion record carries it.
    const observed = await runWithRequestId("req_served_body", async () => {
      const response = await handlerWith({ authenticateMcpRequest })(request());
      return { status: response.status, failure: getRequestFailure() };
    });
    expect(observed).toMatchObject({
      status: 503,
      failure: { sink: "mcp.transport_failed" },
    });
  });
});
