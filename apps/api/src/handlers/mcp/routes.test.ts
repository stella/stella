import { describe, expect, test } from "bun:test";

import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import {
  MCP_ANONYMIZED_DISCOVERY_PATH,
  MCP_DISCOVERY_PATH,
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
});
