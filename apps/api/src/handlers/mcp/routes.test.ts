import { describe, expect, test } from "bun:test";

import { mcpRoute } from "@/api/handlers/mcp/routes";
import {
  MCP_DISCOVERY_PATH,
  ROOT_MCP_DISCOVERY_PATH,
} from "@/api/mcp/constants";
import { getMcpProtectedResourceMetadata } from "@/api/mcp/metadata";

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
