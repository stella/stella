import { describe, expect, test } from "bun:test";

import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import {
  MCP_ANONYMIZED_DISCOVERY_PATH,
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_DISCOVERY_PATH,
  MCP_DOCUMENTS_DISCOVERY_PATH,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
  ROOT_MCP_DISCOVERY_PATH,
  STELLA_CLI_MAXIMUM_VERSION,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";
import { getMcpProtectedResourceMetadata } from "@/api/mcp/metadata";

const mcpRoute = createMcpRoute({
  handleMcpHttpRequest: async () => new Response("Unexpected MCP transport"),
});

describe("MCP protected resource discovery routes", () => {
  const assertMetadataResponse = async (path: string) => {
    const response = await mcpRoute.handle(
      new Request(`http://localhost${path}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
    expect(await response.json()).toEqual(getMcpProtectedResourceMetadata());
  };

  test("serves protected resource metadata from the canonical path", async () => {
    const response = await mcpRoute.handle(
      new Request(`http://localhost${MCP_DISCOVERY_PATH}`),
    );
    const metadata = await response.json();

    expect(response.status).toBe(200);
    expect(metadata).toMatchObject({
      scopes_supported: expect.arrayContaining(["stella:read"]),
      stella_compatibility: {
        api_contract_version: STELLA_MCP_API_CONTRACT_VERSION,
        cli_version: {
          maximum: STELLA_CLI_MAXIMUM_VERSION,
          minimum: STELLA_CLI_MINIMUM_VERSION,
        },
      },
    });
  });

  test("serves protected resource metadata from the root compatibility path", async () => {
    await assertMetadataResponse(ROOT_MCP_DISCOVERY_PATH);
  });

  test("serves protected resource metadata from the anonymized path", async () => {
    const response = await mcpRoute.handle(
      new Request(`http://localhost${MCP_ANONYMIZED_DISCOVERY_PATH}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      getMcpProtectedResourceMetadata("anonymized"),
    );
  });

  test("serves least-privilege metadata from the documents path", async () => {
    const response = await mcpRoute.handle(
      new Request(`http://localhost${MCP_DOCUMENTS_DISCOVERY_PATH}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      getMcpProtectedResourceMetadata("documents"),
    );
  });

  test("answers CORS preflight requests on the root compatibility path", async () => {
    const response = await mcpRoute.handle(
      new Request(`http://localhost${ROOT_MCP_DISCOVERY_PATH}`, {
        method: "OPTIONS",
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
  });

  test("forwards default MCP HTTP methods to the transport handler", async () => {
    const calls: { method: string; mode: string | undefined }[] = [];
    const route = createMcpRoute({
      handleMcpHttpRequest: async (request, options) => {
        calls.push({ method: request.method, mode: options?.mode });
        return new Response("ok");
      },
    });

    for (const method of ["OPTIONS", "GET", "POST", "DELETE"]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential test setup: asserts the recorded call order below
      const response = await route.handle(
        new Request(`http://localhost${MCP_HTTP_PATH}`, { method }),
      );
      expect(response.status).toBe(200);
    }

    expect(calls).toEqual([
      { method: "OPTIONS", mode: undefined },
      { method: "GET", mode: undefined },
      { method: "POST", mode: undefined },
      { method: "DELETE", mode: undefined },
    ]);
  });

  test("leaves the JSON-RPC request body unread for the MCP SDK transport", async () => {
    const jsonRpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    let forwardedBody: string | undefined;
    const route = createMcpRoute({
      handleMcpHttpRequest: async (request) => {
        forwardedBody = await request.text();
        return new Response("ok");
      },
    });

    const response = await route.handle(
      new Request(`http://localhost${MCP_HTTP_PATH}`, {
        body: jsonRpcBody,
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(forwardedBody).toBe(jsonRpcBody);
  });

  test("forwards anonymized MCP HTTP methods with anonymized mode", async () => {
    const calls: { method: string; mode: string | undefined }[] = [];
    const route = createMcpRoute({
      handleMcpHttpRequest: async (request, options) => {
        calls.push({ method: request.method, mode: options?.mode });
        return new Response("ok");
      },
    });

    for (const method of ["OPTIONS", "GET", "POST", "DELETE"]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential test setup: asserts the recorded call order below
      const response = await route.handle(
        new Request(`http://localhost${MCP_ANONYMIZED_HTTP_PATH}`, { method }),
      );
      expect(response.status).toBe(200);
    }

    expect(calls).toEqual([
      { method: "OPTIONS", mode: "anonymized" },
      { method: "GET", mode: "anonymized" },
      { method: "POST", mode: "anonymized" },
      { method: "DELETE", mode: "anonymized" },
    ]);
  });

  test("forwards documents MCP HTTP methods with documents mode", async () => {
    const calls: { method: string; mode: string | undefined }[] = [];
    const route = createMcpRoute({
      handleMcpHttpRequest: async (request, options) => {
        calls.push({ method: request.method, mode: options?.mode });
        return new Response("ok");
      },
    });

    for (const method of ["OPTIONS", "GET", "POST", "DELETE"]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential test setup: asserts the recorded call order below
      const response = await route.handle(
        new Request(`http://localhost${MCP_DOCUMENTS_HTTP_PATH}`, { method }),
      );
      expect(response.status).toBe(200);
    }

    expect(calls).toEqual([
      { method: "OPTIONS", mode: "documents" },
      { method: "GET", mode: "documents" },
      { method: "POST", mode: "documents" },
      { method: "DELETE", mode: "documents" },
    ]);
  });

  test("rejects unsupported MCP HTTP methods before transport handling", async () => {
    let calls = 0;
    const route = createMcpRoute({
      handleMcpHttpRequest: async () => {
        calls += 1;
        return new Response("unexpected");
      },
    });

    for (const path of [
      MCP_HTTP_PATH,
      MCP_DOCUMENTS_HTTP_PATH,
      MCP_ANONYMIZED_HTTP_PATH,
    ]) {
      for (const method of ["PATCH", "PUT"]) {
        // oxlint-disable-next-line no-await-in-loop -- deterministic sequential test setup over a small fixed method list
        const response = await route.handle(
          new Request(`http://localhost${path}`, { method }),
        );

        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe(
          "OPTIONS, GET, POST, DELETE",
        );
      }
    }

    expect(calls).toBe(0);
  });
});
