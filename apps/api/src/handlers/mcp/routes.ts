import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import {
  createMcpAuthenticationFailureLimiter,
  createMcpTransportRateLimitOptions,
} from "@/api/handlers/mcp/transport-rate-limit";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { handleMcpHttpRequest } from "@/api/mcp/server";

/**
 * Only the JSON-RPC transports carry a budget. Protected-resource discovery
 * and CORS preflight are static, credential-free, and answered before a client
 * knows how to authenticate, so throttling them would break discovery rather
 * than bound any cost.
 */
export const mcpRoute = createMcpRoute({
  handleMcpHttpRequest,
  limitAuthenticationFailure: createMcpAuthenticationFailureLimiter(),
  transportMiddleware: [rateLimit(createMcpTransportRateLimitOptions())],
});
