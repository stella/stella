import { describe, expect, test } from "bun:test";

import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import {
  MCP_ANONYMIZED_DISCOVERY_PATH,
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_DISCOVERY_PATH,
  MCP_HTTP_PATH,
  ROOT_MCP_DISCOVERY_PATH,
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
    await assertMetadataResponse(MCP_DISCOVERY_PATH);
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

  test("forwards anonymized MCP HTTP methods with anonymized mode", async () => {
    const calls: { method: string; mode: string | undefined }[] = [];
    const route = createMcpRoute({
      handleMcpHttpRequest: async (request, options) => {
        calls.push({ method: request.method, mode: options?.mode });
        return new Response("ok");
      },
    });

    for (const method of ["OPTIONS", "GET", "POST", "DELETE"]) {
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

  test("rejects unsupported MCP HTTP methods before transport handling", async () => {
    let calls = 0;
    const route = createMcpRoute({
      handleMcpHttpRequest: async () => {
        calls += 1;
        return new Response("unexpected");
      },
    });

    for (const path of [MCP_HTTP_PATH, MCP_ANONYMIZED_HTTP_PATH]) {
      for (const method of ["PATCH", "PUT"]) {
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
