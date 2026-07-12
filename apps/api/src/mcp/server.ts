import { captureError } from "@/api/lib/analytics/capture";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { listMcpResources, readMcpResource } from "@/api/mcp/resources";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import {
  getMcpToolDefinition,
  getMcpToolScopeHint,
  handleMcpToolCall,
  listMcpTools,
} from "@/api/mcp/tools";

export const handleMcpHttpRequest = createMcpHttpRequestHandler({
  authenticateMcpRequest,
  captureError,
  getMcpToolDefinition,
  getMcpToolScopeHint,
  handleMcpToolCall,
  listMcpResources,
  listMcpTools,
  readMcpResource,
  resolveMcpSessionContext,
});
