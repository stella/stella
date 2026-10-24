import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";

import { apiPipeline } from "@/api/api-pipeline";
import { env } from "@/api/env";
import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import { PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS } from "@/api/handlers/public-cors";
import { createHttpApp } from "@/api/http/app";
import { responseCachePolicy } from "@/api/http/cache";
import { frontendOrigins } from "@/api/lib/dev-origins";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import {
  MCP_ANONYMIZED_DISCOVERY_PATH,
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_DISCOVERY_PATH,
  MCP_DOCUMENTS_DISCOVERY_PATH,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
  MCP_LAW_DISCOVERY_PATH,
  MCP_LAW_HTTP_PATH,
  MCP_STATELESS_ALLOW_HEADER,
  ROOT_MCP_DISCOVERY_PATH,
  STELLA_API_CONTRACT,
  STELLA_CLI_LATEST_VERSION,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";
import {
  createMcpCorsHeaders,
  getMcpProtectedResourceMetadata,
} from "@/api/mcp/metadata";
import { MCP_LAW_RESOURCE_SCOPES } from "@/api/mcp/resource-policy-contract";
import { runtimeMode } from "@/api/runtime-mode";
import { serveForTest } from "@/api/tests/helpers/test-server";

type HandleMcpHttpRequest = Parameters<
  typeof createMcpRoute
>[0]["handleMcpHttpRequest"];

/** The MCP routes over a real socket with a stand-in transport. */
const serveMcpRoute = (handleMcpHttpRequest: HandleMcpHttpRequest) =>
  serveForTest(
    createHttpApp({
      routes: createMcpRoute({ handleMcpHttpRequest }),
      middleware: [responseCachePolicy, errorBoundary],
    }),
  );

const mcpRoute = serveMcpRoute(
  async () => new Response("Unexpected MCP transport"),
);
afterAll(async () => {
  await mcpRoute.stop();
});

/**
 * A transport path answers its own preflight and forwards every other method
 * it serves, with the path's mode, to the transport handler.
 */
const assertTransportForwarding = async (
  path: string,
  mode: McpMode | undefined,
) => {
  const calls: { method: string; mode: string | undefined }[] = [];
  await using route = serveMcpRoute(async (request, options) => {
    calls.push({ method: request.method, mode: options?.mode });
    return new Response("ok");
  });

  const preflight = await route.fetch(
    new Request(`http://localhost${path}`, { method: "OPTIONS" }),
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Allow")).toBe(MCP_STATELESS_ALLOW_HEADER);

  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await route.fetch(
      new Request(`http://localhost${path}`, { method }),
    );
    expect(response.status).toBe(200);
  }

  expect(calls).toEqual([
    { method: "GET", mode },
    { method: "POST", mode },
    { method: "DELETE", mode },
  ]);
};

describe("MCP protected resource discovery routes", () => {
  const assertMetadataResponse = async (path: string) => {
    const response = await mcpRoute.fetch(
      new Request(`http://localhost${path}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(await response.json()).toEqual(getMcpProtectedResourceMetadata());
  };

  test("serves protected resource metadata from the canonical path", async () => {
    const response = await mcpRoute.fetch(
      new Request(`http://localhost${MCP_DISCOVERY_PATH}`),
    );
    const metadata = await response.json();

    expect(response.status).toBe(200);
    expect(metadata).toMatchObject({
      scopes_supported: expect.arrayContaining(["stella:read"]),
      stella_contract: {
        capabilities: STELLA_API_CONTRACT.capabilities,
        protocol: STELLA_API_CONTRACT.protocol,
        revision: STELLA_API_CONTRACT.revision,
      },
      stella_compatibility: {
        api_contract_version: STELLA_MCP_API_CONTRACT_VERSION,
        cli_version: {
          maximum: STELLA_CLI_LATEST_VERSION,
          minimum: STELLA_CLI_MINIMUM_VERSION,
        },
      },
    });
  });

  test("serves protected resource metadata from the root compatibility path", async () => {
    await assertMetadataResponse(ROOT_MCP_DISCOVERY_PATH);
  });

  test("serves protected resource metadata from the anonymized path", async () => {
    const response = await mcpRoute.fetch(
      new Request(`http://localhost${MCP_ANONYMIZED_DISCOVERY_PATH}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      getMcpProtectedResourceMetadata("anonymized"),
    );
  });

  test("serves least-privilege metadata from the documents path", async () => {
    const response = await mcpRoute.fetch(
      new Request(`http://localhost${MCP_DOCUMENTS_DISCOVERY_PATH}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      getMcpProtectedResourceMetadata("documents"),
    );
  });

  test("serves the derived law resource scopes from the law path", async () => {
    const response = await mcpRoute.fetch(
      new Request(`http://localhost${MCP_LAW_DISCOVERY_PATH}`),
    );

    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(metadata).toEqual(getMcpProtectedResourceMetadata("law"));
    expect(metadata).toMatchObject({
      scopes_supported: MCP_LAW_RESOURCE_SCOPES,
    });
  });

  test("answers CORS preflight requests on the root compatibility path", async () => {
    const response = await mcpRoute.fetch(
      new Request(`http://localhost${ROOT_MCP_DISCOVERY_PATH}`, {
        method: "OPTIONS",
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
    expect(response.headers.get("Access-Control-Max-Age")).toBe(
      String(PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS),
    );
  });

  test("forwards default MCP HTTP methods to the transport handler", async () => {
    await assertTransportForwarding(MCP_HTTP_PATH, undefined);
  });

  test("leaves each JSON-RPC request body unread for the MCP SDK transport", async () => {
    const jsonRpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const forwarded: { body: string; mode: string | undefined }[] = [];
    await using route = serveMcpRoute(async (request, options) => {
      forwarded.push({ body: await request.text(), mode: options?.mode });
      return new Response("ok");
    });

    for (const path of [MCP_HTTP_PATH, MCP_DOCUMENTS_HTTP_PATH]) {
      const response = await route.fetch(
        new Request(`http://localhost${path}`, {
          body: jsonRpcBody,
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );

      expect(response.status).toBe(200);
    }
    expect(forwarded).toEqual([
      { body: jsonRpcBody, mode: undefined },
      { body: jsonRpcBody, mode: "documents" },
    ]);
  });

  test("forwards anonymized MCP HTTP methods with anonymized mode", async () => {
    await assertTransportForwarding(MCP_ANONYMIZED_HTTP_PATH, "anonymized");
  });

  test("forwards documents MCP HTTP methods with documents mode", async () => {
    await assertTransportForwarding(MCP_DOCUMENTS_HTTP_PATH, "documents");
  });

  test("forwards law MCP HTTP methods with law mode", async () => {
    await assertTransportForwarding(MCP_LAW_HTTP_PATH, "law");
  });

  test("owns the preflight for every MCP path with exactly the methods the path serves", async () => {
    const transportPreflight = await mcpRoute.fetch(
      new Request(`http://localhost${MCP_HTTP_PATH}`, { method: "OPTIONS" }),
    );
    const discoveryPreflight = await mcpRoute.fetch(
      new Request(`http://localhost${MCP_DISCOVERY_PATH}`, {
        method: "OPTIONS",
      }),
    );

    expect(transportPreflight.status).toBe(204);
    expect(transportPreflight.headers.get("Access-Control-Allow-Methods")).toBe(
      MCP_STATELESS_ALLOW_HEADER,
    );
    expect(transportPreflight.headers.get("Allow")).toBe(
      MCP_STATELESS_ALLOW_HEADER,
    );
    expect(discoveryPreflight.status).toBe(204);
    expect(discoveryPreflight.headers.get("Allow")).toBe("GET, OPTIONS");
  });

  test("rejects unsupported MCP HTTP methods before transport handling", async () => {
    let calls = 0;
    await using route = serveMcpRoute(async () => {
      calls += 1;
      return new Response("unexpected");
    });

    for (const path of [
      MCP_HTTP_PATH,
      MCP_DOCUMENTS_HTTP_PATH,
      MCP_ANONYMIZED_HTTP_PATH,
      MCP_LAW_HTTP_PATH,
    ]) {
      for (const method of ["PATCH", "PUT"]) {
        const response = await route.fetch(
          new Request(`http://localhost${path}`, { method }),
        );

        // One 405 for the endpoint, whichever layer refuses the method: the
        // transport refuses DELETE with the same `Allow` and envelope.
        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe(MCP_STATELESS_ALLOW_HEADER);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(await response.json()).toEqual({
          error: {
            code: -32_000,
            message: "Method Not Allowed: this endpoint serves no session.",
          },
          id: null,
          jsonrpc: "2.0",
        });
      }
    }

    expect(calls).toBe(0);
  });
});

describe("MCP CORS under the API pipeline", () => {
  // An origin the API's credentialed CORS admits, so a credentialed answer
  // would show if the MCP routes did not own their CORS.
  const allowedOrigin =
    frontendOrigins({
      frontendUrl: env.FRONTEND_URL,
      runtimeMode: runtimeMode(),
    }).at(0) ?? panic("No frontend origin is configured");

  const serveUnderPipeline = () =>
    serveForTest(
      createHttpApp({
        routes: createMcpRoute({
          handleMcpHttpRequest: async () =>
            new Response("ok", { headers: createMcpCorsHeaders() }),
        }),
        middleware: apiPipeline,
      }),
    );

  const browserPreflight = (path: string) =>
    new Request(`http://localhost${path}`, {
      method: "OPTIONS",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "POST",
      },
    });

  test("answers an MCP browser preflight itself, without the credentialed default", async () => {
    await using api = serveUnderPipeline();

    for (const path of [MCP_HTTP_PATH, MCP_DISCOVERY_PATH]) {
      const response = await api.fetch(browserPreflight(path));

      expect(response.status).toBe(204);
      // A browser refuses `Allow-Origin: *` with credentials, and this
      // endpoint authenticates with a bearer token rather than cookies.
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(
        response.headers.get("Access-Control-Allow-Credentials"),
      ).toBeNull();
      expect(response.headers.get("Allow")).not.toBeNull();
    }
  });

  test("serves discovery the same to every origin, so a shared cache keeps one copy", async () => {
    await using api = serveUnderPipeline();

    const response = await api.fetch(
      new Request(`http://localhost${MCP_DISCOVERY_PATH}`, {
        headers: { origin: allowedOrigin },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Vary")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
  });

  test("drops the global credentialed CORS default on MCP transport responses", async () => {
    await using api = serveUnderPipeline();

    const response = await api.fetch(
      new Request(`http://localhost${MCP_HTTP_PATH}`, {
        method: "POST",
        headers: { origin: allowedOrigin },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("leaves preflight for a non-MCP path to the global CORS layer", async () => {
    await using api = serveUnderPipeline();

    const response = await api.fetch(browserPreflight("/matters"));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      allowedOrigin,
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
    expect(response.headers.get("Allow")).toBeNull();
  });
});
