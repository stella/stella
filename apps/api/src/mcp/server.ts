import { captureError } from "@/api/lib/analytics/capture";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import { recordMcpSessionInitialized } from "@/api/mcp/client-identity";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { listMcpResources, readMcpResource } from "@/api/mcp/resources";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import {
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
  handleMcpToolCall,
  listMcpTools,
} from "@/api/mcp/tools";

export const handleMcpHttpRequest = createMcpHttpRequestHandler({
  authenticateMcpRequest,
  captureError,
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
  handleMcpToolCall,
  listMcpResources,
  listMcpTools,
  readMcpResource,
  recordMcpSessionInitialized,
  resolveMcpSessionContext,
});
