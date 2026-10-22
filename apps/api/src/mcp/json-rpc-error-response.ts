import { MCP_STATELESS_ALLOW_HEADER } from "@/api/mcp/constants";
import { createMcpCorsHeaders } from "@/api/mcp/metadata";

/** Transport-level refusal (the SDK reserves -32000..-32099 for these). */
export const MCP_TRANSPORT_ERROR_CODE = -32_000;
/** Refused for want of usable credentials, in either direction (401/403). */
export const MCP_ACCESS_DENIED_ERROR_CODE = -32_001;

/**
 * Every refusal this endpoint serves answers in the JSON-RPC envelope a client
 * already parses. A bare string body forces a caller to branch on status codes
 * before it can read the reason, and a body with no `Content-Type` is served as
 * `application/octet-stream`.
 */
export const mcpJsonRpcErrorResponse = ({
  code,
  headers,
  message,
  status,
}: {
  code: number;
  headers: Headers;
  message: string;
  status: number;
}) => {
  headers.set("Content-Type", "application/json");

  return new Response(
    JSON.stringify({ error: { code, message }, id: null, jsonrpc: "2.0" }),
    { headers, status },
  );
};

/**
 * The one 405 the MCP endpoint serves, whichever layer refuses the method: the
 * route for a method it never hands to the transport, the transport for
 * session termination once the token is accepted. Both state the same `Allow`.
 */
export const mcpMethodNotAllowedResponse = () => {
  const headers = createMcpCorsHeaders();
  headers.set("Allow", MCP_STATELESS_ALLOW_HEADER);

  return mcpJsonRpcErrorResponse({
    code: MCP_TRANSPORT_ERROR_CODE,
    headers,
    message: "Method Not Allowed: this endpoint serves no session.",
    status: 405,
  });
};
