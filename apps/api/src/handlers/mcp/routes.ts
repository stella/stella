import Elysia from "elysia";

import {
  MCP_DISCOVERY_PATH,
  MCP_HTTP_PATH,
  ROOT_MCP_DISCOVERY_PATH,
} from "@/api/mcp/constants";
import {
  createMcpMetadataHeaders,
  getMcpProtectedResourceMetadata,
} from "@/api/mcp/metadata";
import { handleMcpHttpRequest } from "@/api/mcp/server";

const applyHeaders = ({
  headers,
  set,
}: {
  headers: Headers;
  set: { headers: Record<string, string | number | boolean | undefined> };
}) => {
  for (const [key, value] of headers) {
    set.headers[key] = value;
  }
};

export const mcpRoute = new Elysia()
  .options(ROOT_MCP_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createMcpMetadataHeaders(),
      set,
    });
    set.status = 204;
    return "";
  })
  .get(ROOT_MCP_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createMcpMetadataHeaders(),
      set,
    });
    return getMcpProtectedResourceMetadata();
  })
  .options(MCP_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createMcpMetadataHeaders(),
      set,
    });
    set.status = 204;
    return "";
  })
  .get(MCP_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createMcpMetadataHeaders(),
      set,
    });
    return getMcpProtectedResourceMetadata();
  })
  .options(
    MCP_HTTP_PATH,
    async ({ request }) => await handleMcpHttpRequest(request),
  )
  .get(
    MCP_HTTP_PATH,
    async ({ request }) => await handleMcpHttpRequest(request),
  )
  .post(
    MCP_HTTP_PATH,
    async ({ request }) => await handleMcpHttpRequest(request),
  )
  .delete(
    MCP_HTTP_PATH,
    async ({ request }) => await handleMcpHttpRequest(request),
  );
