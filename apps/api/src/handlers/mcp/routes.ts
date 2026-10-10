import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import { createMcpAuthenticationFailureLimiter } from "@/api/handlers/mcp/transport-rate-limit";
import { handleMcpHttpRequest } from "@/api/mcp/server";

export const mcpRoute = createMcpRoute({
  handleMcpHttpRequest,
  limitAuthenticationFailure: createMcpAuthenticationFailureLimiter(),
});
