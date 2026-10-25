import { panic, Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import { connect } from "node:net";

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
    listMcpResources: () => [],
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

type RawResponse = { status: number; body: string };

const decodeChunked = (body: string): string => {
  let decoded = "";
  let rest = body;
  while (true) {
    const lineEnd = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (!Number.isInteger(size) || size === 0) {
      return decoded;
    }
    decoded += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
};

/**
 * POST over a raw socket with the headers and the body in ONE write, the way
 * a load balancer forwards a small request. Bun's own fetch writes them
 * separately, which does not exercise a body that arrived before the handler.
 */
const postInOneWrite = async (
  port: number,
  path: string,
  body: string,
): Promise<RawResponse> =>
  await new Promise<RawResponse>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.setEncoding("utf-8");
    let received = "";
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("error", (error) => {
      reject(error);
    });
    socket.on("close", () => {
      const separator = received.indexOf("\r\n\r\n");
      const head = received.slice(0, separator);
      const rawBody = received.slice(separator + 4);
      resolve({
        status: Number(head.split(" ")[1]),
        body: /^transfer-encoding:\s*chunked/imu.test(head)
          ? decodeChunked(rawBody)
          : rawBody,
      });
    });
    socket.write(
      [
        `POST ${path} HTTP/1.1`,
        "Host: localhost",
        "Accept: application/json, text/event-stream",
        "Authorization: Bearer token",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body, "utf-8")}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"),
    );
  });

describe("MCP over a served socket", () => {
  test("answers initialize when the bounded body arrived with its headers", async () => {
    const observeTransportFailure = mock();
    const app = createHttpApp({
      routes: createMcpRoute({
        handleMcpHttpRequest: handlerWith({ observeTransportFailure }),
      }),
      middleware: [awaitedStage],
    });
    const server = Bun.serve({ port: 0, ...app.serveOptions });
    try {
      const port = server.port;
      if (port === undefined) {
        panic("The test server did not bind a port");
      }
      const response = await postInOneWrite(port, "/mcp", initializeBody);
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
    } finally {
      await server.stop(true);
    }
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
      observeTransportFailure,
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
