import {
  readAdvancedMetadata,
  readAnonymizedMetadata,
  readDefaultMetadata,
  readDocumentsMetadata,
  readLawMetadata,
} from "@/api/handlers/mcp/read-discovery-metadata";
import type { createMcpAuthenticationFailureLimiter } from "@/api/handlers/mcp/transport-rate-limit";
import type { Middleware } from "@/api/http/route";
import { mount, routes } from "@/api/http/route";
import { resolveRateLimitClientAddress } from "@/api/lib/client-ip";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { defineEndpoint } from "@/api/lib/endpoints";
import {
  MCP_ADVANCED_DISCOVERY_PATH,
  MCP_ADVANCED_HTTP_PATH,
  MCP_ANONYMIZED_DISCOVERY_PATH,
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_DISCOVERY_PATH,
  MCP_DOCUMENTS_DISCOVERY_PATH,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
  MCP_LAW_DISCOVERY_PATH,
  MCP_LAW_HTTP_PATH,
  ROOT_MCP_DISCOVERY_PATH,
} from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";
import { mcpMethodNotAllowedResponse } from "@/api/mcp/json-rpc-error-response";
import {
  createMcpDiscoveryPreflightHeaders,
  createMcpPreflightHeaders,
} from "@/api/mcp/metadata";

type HandleMcpHttpRequest = (
  request: Request,
  options?: { clientIp?: string | null | undefined; mode?: McpMode },
) => Response | Promise<Response>;

/**
 * A preflight answered by the MCP surface itself: bearer-authenticated and
 * credential-free, so any origin may call it, with exactly the methods the
 * path serves.
 */
const preflight = (createHeaders: () => Headers) =>
  defineEndpoint.public(
    { cors: "own" },
    () => new Response(null, { headers: createHeaders(), status: 204 }),
  );

const transportPreflight = preflight(createMcpPreflightHeaders);
const discoveryPreflight = preflight(createMcpDiscoveryPreflightHeaders);

/**
 * The one 405 for a method the transport is never handed, in the envelope and
 * with the `Allow` value the transport answers a refused `DELETE` with.
 */
const transportMethodNotAllowed = defineEndpoint.public(
  { bodyMode: "none", cors: "own" },
  () => mcpMethodNotAllowedResponse(),
);

export const createMcpRoute = ({
  handleMcpHttpRequest,
  limitAuthenticationFailure,
  transportMiddleware = [],
}: {
  handleMcpHttpRequest: HandleMcpHttpRequest;
  limitAuthenticationFailure?: ReturnType<
    typeof createMcpAuthenticationFailureLimiter
  >;
  /** Stages only the JSON-RPC transports pass through (their rate limit). */
  transportMiddleware?: readonly Middleware[];
}) => {
  /**
   * One MCP transport. The SDK reads the JSON-RPC body itself, so the route
   * never does, and the transport answers its own CORS: it is
   * bearer-authenticated and never reads cookies, and a browser refuses a
   * credentialed request answered with `Access-Control-Allow-Origin: *`.
   */
  const transport = (mode?: McpMode) =>
    declareAggregateMutation(
      defineEndpoint.public(
        { bodyMode: "none", cors: "own" },
        async ({ request, server }) => {
          const options = {
            clientIp: resolveRateLimitClientAddress({ request, server }),
            ...(mode === undefined ? {} : { mode }),
          };
          if (!limitAuthenticationFailure) {
            return await handleMcpHttpRequest(request, options);
          }
          return await limitAuthenticationFailure({
            request,
            clientIp: options.clientIp,
            run: async () => await handleMcpHttpRequest(request, options),
          });
        },
      ),
      {
        type: "independent",
        reason:
          "MCP transport dispatches to capability handlers that own their aggregate mutations; the transport itself owns no aggregate state.",
      },
    );

  const transportMethods = (mode?: McpMode) => {
    const definition = transport(mode);
    return {
      GET: definition,
      POST: definition,
      DELETE: definition,
      PUT: transportMethodNotAllowed,
      PATCH: transportMethodNotAllowed,
    };
  };

  return mount([
    routes({
      [ROOT_MCP_DISCOVERY_PATH]: {
        GET: readDefaultMetadata,
        OPTIONS: discoveryPreflight,
      },
      [MCP_DISCOVERY_PATH]: {
        GET: readDefaultMetadata,
        OPTIONS: discoveryPreflight,
      },
      [MCP_ADVANCED_DISCOVERY_PATH]: {
        GET: readAdvancedMetadata,
        OPTIONS: discoveryPreflight,
      },
      [MCP_ANONYMIZED_DISCOVERY_PATH]: {
        GET: readAnonymizedMetadata,
        OPTIONS: discoveryPreflight,
      },
      [MCP_DOCUMENTS_DISCOVERY_PATH]: {
        GET: readDocumentsMetadata,
        OPTIONS: discoveryPreflight,
      },
      [MCP_LAW_DISCOVERY_PATH]: {
        GET: readLawMetadata,
        OPTIONS: discoveryPreflight,
      },
      [MCP_HTTP_PATH]: { OPTIONS: transportPreflight },
      [MCP_ADVANCED_HTTP_PATH]: { OPTIONS: transportPreflight },
      [MCP_ANONYMIZED_HTTP_PATH]: { OPTIONS: transportPreflight },
      [MCP_DOCUMENTS_HTTP_PATH]: { OPTIONS: transportPreflight },
      [MCP_LAW_HTTP_PATH]: { OPTIONS: transportPreflight },
    }),
    routes(
      {
        [MCP_HTTP_PATH]: transportMethods(),
        [MCP_ADVANCED_HTTP_PATH]: transportMethods("advanced"),
        [MCP_ANONYMIZED_HTTP_PATH]: transportMethods("anonymized"),
        [MCP_DOCUMENTS_HTTP_PATH]: transportMethods("documents"),
        [MCP_LAW_HTTP_PATH]: transportMethods("law"),
      },
      { middleware: transportMiddleware },
    ),
  ]);
};
