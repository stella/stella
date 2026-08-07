import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";

type McpLifecycleRequest = {
  id?: string | number;
  method?: string;
};

/** Handle standard MCP lifecycle messages for in-process CLI test servers. */
export const respondToMcpLifecycle = (
  request: McpLifecycleRequest,
): Response | null => {
  if (request.method === "initialize") {
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { resources: {}, tools: {} },
        serverInfo: { name: "stella-cli-test", version: "1.0.0" },
      },
    });
  }
  if (request.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  return null;
};
