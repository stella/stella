import Elysia from "elysia";

import {
  MCP_ANONYMIZED_DISCOVERY_PATH,
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_DISCOVERY_PATH,
  MCP_HTTP_PATH,
  ROOT_MCP_DISCOVERY_PATH,
} from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";
import {
  createMcpMetadataHeaders,
  getMcpProtectedResourceMetadata,
} from "@/api/mcp/metadata";

type HandleMcpHttpRequest = (
  request: Request,
  options?: { mode?: McpMode },
) => Promise<Response>;

type RouteSet = {
  headers: Record<string, string | number | boolean | undefined>;
  status?: number | string;
};

const MCP_HTTP_METHOD_ALLOW_HEADER = "OPTIONS, GET, POST, DELETE";
const MCP_HTTP_METHODS = new Set(MCP_HTTP_METHOD_ALLOW_HEADER.split(", "));

const applyHeaders = ({
  headers,
  set,
}: {
  headers: Headers;
  set: RouteSet;
}) => {
  for (const [key, value] of headers) {
    set.headers[key] = value;
  }
};

const discoveryOptionsHandler = ({ set }: { set: RouteSet }) => {
  applyHeaders({
    headers: createMcpMetadataHeaders(),
    set,
  });
  set.status = 204;
  return "";
};

const discoveryHandler =
  (mode?: McpMode) =>
  ({ set }: { set: RouteSet }) => {
    applyHeaders({
      headers: createMcpMetadataHeaders(),
      set,
    });
    return getMcpProtectedResourceMetadata(mode);
  };

export const createMcpRoute = ({
  handleMcpHttpRequest,
}: {
  handleMcpHttpRequest: HandleMcpHttpRequest;
}) => {
  const handleMcpTransportRoute = async (
    request: Request,
    options?: { mode?: McpMode },
  ) => {
    if (!MCP_HTTP_METHODS.has(request.method)) {
      return new Response("Method Not Allowed", {
        headers: { Allow: MCP_HTTP_METHOD_ALLOW_HEADER },
        status: 405,
      });
    }

    return await handleMcpHttpRequest(request, options);
  };

  return new Elysia()
    .options(ROOT_MCP_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(ROOT_MCP_DISCOVERY_PATH, discoveryHandler())
    .options(MCP_ANONYMIZED_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(MCP_ANONYMIZED_DISCOVERY_PATH, discoveryHandler("anonymized"))
    .options(MCP_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(MCP_DISCOVERY_PATH, discoveryHandler())
    .all(
      MCP_HTTP_PATH,
      async ({ request }) => await handleMcpTransportRoute(request),
    )
    .all(
      MCP_ANONYMIZED_HTTP_PATH,
      async ({ request }) =>
        await handleMcpTransportRoute(request, { mode: "anonymized" }),
    );
};
