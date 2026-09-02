import { resolveClientIp } from "@/api/lib/client-ip";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import type {
  RateLimitGenerator,
  RateLimitOptions,
} from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
} from "@/api/mcp/constants";

const MCP_TRANSPORT_RATE_LIMIT_SCOPE = "mcp-transport";
const MCP_TRANSPORT_ADDRESS_RATE_LIMIT_SCOPE = "mcp-transport-address";

const MCP_TRANSPORT_PATHS: ReadonlySet<string> = new Set([
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
]);

/**
 * Only the JSON-RPC transport paths carry a budget. Protected-resource
 * discovery and CORS preflight are static, credential-free, and answered before
 * a client knows how to authenticate, so throttling them would break discovery
 * rather than bound any cost.
 */
export const isMcpTransportRateLimitedRequest = (request: Request): boolean =>
  request.method !== "OPTIONS" &&
  MCP_TRANSPORT_PATHS.has(new URL(request.url).pathname);

const BEARER_SCHEME = "bearer ";

/**
 * The limiter runs ahead of MCP authentication, so the token's organization and
 * session are not resolvable yet; the bearer credential itself is the closest
 * stable stand-in. It is hashed and never used raw: the counter key travels to
 * Redis and into diagnostics, and a credential must not. Keying on the
 * credential rather than the address also keeps one organization's agents from
 * sharing a bucket with every unrelated caller behind the same NAT. A request
 * with no bearer token falls back to the client address.
 */
export const mcpTransportRateLimitKey: RateLimitGenerator = (
  request,
  server,
) => {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.toLowerCase().startsWith(BEARER_SCHEME)
    ? authorization.slice(BEARER_SCHEME.length).trim()
    : "";
  if (token.length === 0) {
    return addressKey(MCP_TRANSPORT_RATE_LIMIT_SCOPE, request, server);
  }
  const digest = new Bun.CryptoHasher("sha256").update(token).digest("hex");
  return `${MCP_TRANSPORT_RATE_LIMIT_SCOPE}:token:${digest}`;
};

const addressKey = (
  scope: string,
  request: Request,
  server: Parameters<RateLimitGenerator>[1],
): string => {
  const clientIp = resolveClientIp(request, server);
  return clientIp ? `${scope}:ip:${clientIp}` : scope;
};

/**
 * The credential bucket alone does not bound a caller who invents a new
 * bearer value per request: every value opens a fresh bucket, and every
 * request still costs a token verification. The address bucket sits in front
 * of it so that rotation is charged to the one thing the caller cannot rotate.
 */
export const mcpTransportAddressRateLimitKey: RateLimitGenerator = (
  request,
  server,
) => addressKey(MCP_TRANSPORT_ADDRESS_RATE_LIMIT_SCOPE, request, server);

/**
 * A throttled call answers in the protocol's own error envelope: an MCP client
 * parses every transport response as JSON-RPC, and a bare 429 body surfaces as
 * a parse failure instead of a retryable server error. `id: null` is the
 * JSON-RPC 2.0 form for a failure that cannot be attributed to a request id
 * (the limiter refuses the call before anything reads the body), and the code
 * sits in the implementation-defined server-error range.
 */
export const MCP_RATE_LIMIT_JSON_RPC_ERROR = {
  jsonrpc: "2.0",
  id: null,
  error: {
    code: -32_000,
    message:
      "Rate limited: too many MCP requests. Retry after the interval in the Retry-After header.",
  },
} as const;

/**
 * Everything but the counter store, so a test can drive the shipped policy
 * against an in-memory context instead of restating the limits.
 */
export const MCP_TRANSPORT_RATE_LIMIT_POLICY = {
  duration: API_RATE_LIMITS.mcpTransport.duration,
  errorResponse: MCP_RATE_LIMIT_JSON_RPC_ERROR,
  max: API_RATE_LIMITS.mcpTransport.max,
  skip: (request: Request) => !isMcpTransportRateLimitedRequest(request),
} as const satisfies Omit<RateLimitOptions, "context" | "generator">;

export const MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY = {
  ...MCP_TRANSPORT_RATE_LIMIT_POLICY,
  duration: API_RATE_LIMITS.mcpTransportAddress.duration,
  max: API_RATE_LIMITS.mcpTransportAddress.max,
} as const satisfies Omit<RateLimitOptions, "context" | "generator">;

export const createMcpTransportRateLimitOptions = () =>
  ({
    ...MCP_TRANSPORT_RATE_LIMIT_POLICY,
    ...createRedisRateLimit({
      counterKeyGenerator: mcpTransportRateLimitKey,
      failurePolicy: "fail_open_local",
      scope: MCP_TRANSPORT_RATE_LIMIT_SCOPE,
    }),
  }) as const satisfies RateLimitOptions;

export const createMcpTransportAddressRateLimitOptions = () =>
  ({
    ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
    ...createRedisRateLimit({
      counterKeyGenerator: mcpTransportAddressRateLimitKey,
      failurePolicy: "fail_open_local",
      scope: MCP_TRANSPORT_ADDRESS_RATE_LIMIT_SCOPE,
    }),
  }) as const satisfies RateLimitOptions;
