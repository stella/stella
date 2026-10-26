import type { RequestId } from "@modelcontextprotocol/server";

import { MCP_STATELESS_ALLOW_HEADER } from "@/api/mcp/constants";
import { createMcpCorsHeaders } from "@/api/mcp/metadata";

/** Transport-level refusal (the SDK reserves -32000..-32099 for these). */
export const MCP_TRANSPORT_ERROR_CODE = -32_000;
/** Refused for want of usable credentials, in either direction (401/403). */
export const MCP_ACCESS_DENIED_ERROR_CODE = -32_001;

/**
 * The id an error answering this body carries (JSON-RPC 2.0 §5): the id of a
 * single request, and `null` only where none is determinable: a body not yet
 * read or not parseable, a notification, a posted response, or a batch.
 */
export const jsonRpcRequestId = (body: unknown): RequestId | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const { id, method }: Record<string, unknown> = { ...body };
  if (typeof method !== "string") {
    return null;
  }
  return typeof id === "string" || typeof id === "number" ? id : null;
};

/**
 * Every refusal this endpoint serves answers in the JSON-RPC envelope a client
 * already parses. A bare string body forces a caller to branch on status codes
 * before it can read the reason, and a body with no `Content-Type` is served as
 * `application/octet-stream`. `id` is required so each refusal states whether
 * it answers a request it has read: `null` before the body is read, otherwise
 * the request's own id from {@link jsonRpcRequestId}.
 */
export const mcpJsonRpcErrorResponse = ({
  code,
  headers,
  id,
  message,
  status,
}: {
  code: number;
  headers: Headers;
  id: RequestId | null;
  message: string;
  status: number;
}) => {
  headers.set("Content-Type", "application/json");

  return new Response(
    JSON.stringify({ error: { code, message }, id, jsonrpc: "2.0" }),
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
    // Refused from the method alone; no body is read.
    id: null,
    message: "Method Not Allowed: this endpoint serves no session.",
    status: 405,
  });
};
