import { captureError } from "@/api/lib/analytics";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import {
  getMcpToolDefinition,
  handleMcpToolCall,
  listMcpTools,
} from "@/api/mcp/tools";

export const handleMcpHttpRequest = createMcpHttpRequestHandler({
  authenticateMcpRequest,
  captureError,
  getMcpToolDefinition,
  handleMcpToolCall,
  listMcpTools,
  resolveMcpSessionContext,
});
