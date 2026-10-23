import Elysia, { type Context } from "elysia";

import {
  readAdvancedMetadata,
  readAnonymizedMetadata,
  readDefaultMetadata,
  readDocumentsMetadata,
  readLawMetadata,
} from "@/api/handlers/mcp/read-discovery-metadata";
import type { createMcpAuthenticationFailureLimiter } from "@/api/handlers/mcp/transport-rate-limit";
import { dropCredentialedCors } from "@/api/handlers/public-cors";
import { resolveRateLimitClientAddress } from "@/api/lib/client-ip";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { createRequestRouteClassifier } from "@/api/lib/rate-limit/tenant-action-boundary";
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
import {
  createMcpDiscoveryPreflightHeaders,
  createMcpPreflightHeaders,
} from "@/api/mcp/metadata";

type HandleMcpHttpRequest = (
  request: Request,
  options?: { clientIp?: string | null | undefined; mode?: McpMode },
) => Response | Promise<Response>;

type RouteSet = {
  headers: Record<string, string | number | boolean | undefined>;
  status?: number | string;
};

const MCP_HTTP_METHOD_ALLOW_HEADER = "OPTIONS, GET, POST, DELETE";
const MCP_HTTP_METHODS = new Set(MCP_HTTP_METHOD_ALLOW_HEADER.split(", "));

const applyHeaders = ({
  headers,
  set,
}: {
  headers: Headers;
  set: RouteSet;
}) => {
  dropCredentialedCors(set);
  for (const [key, value] of headers) {
    set.headers[key] = value;
  }
};

/**
 * Preflight headers per MCP path. The global CORS layer answers every OPTIONS
 * request before routing, so unless this runs ahead of it the endpoint
 * advertises that layer's method list (PUT and PATCH included) instead of what
 * the MCP route serves, and the route's own preflight branch is unreachable.
 */
const MCP_PREFLIGHT_HEADERS_BY_PATH = new Map<string, () => Headers>([
  [MCP_ADVANCED_HTTP_PATH, createMcpPreflightHeaders],
  [MCP_HTTP_PATH, createMcpPreflightHeaders],
  [MCP_ANONYMIZED_HTTP_PATH, createMcpPreflightHeaders],
  [MCP_DOCUMENTS_HTTP_PATH, createMcpPreflightHeaders],
  [MCP_LAW_HTTP_PATH, createMcpPreflightHeaders],
  [ROOT_MCP_DISCOVERY_PATH, createMcpDiscoveryPreflightHeaders],
  [MCP_ADVANCED_DISCOVERY_PATH, createMcpDiscoveryPreflightHeaders],
  [MCP_DISCOVERY_PATH, createMcpDiscoveryPreflightHeaders],
  [MCP_ANONYMIZED_DISCOVERY_PATH, createMcpDiscoveryPreflightHeaders],
  [MCP_DOCUMENTS_DISCOVERY_PATH, createMcpDiscoveryPreflightHeaders],
  [MCP_LAW_DISCOVERY_PATH, createMcpDiscoveryPreflightHeaders],
]);

export const handleMcpPreflightRequest = (
  request: Request,
  set: RouteSet,
): Response | undefined => {
  if (request.method !== "OPTIONS") {
    return undefined;
  }
  const createHeaders = MCP_PREFLIGHT_HEADERS_BY_PATH.get(
    new URL(request.url).pathname,
  );
  if (createHeaders === undefined) {
    return undefined;
  }

  dropCredentialedCors(set);
  return new Response(null, { headers: createHeaders(), status: 204 });
};

const discoveryOptionsHandler = ({ set }: { set: RouteSet }) => {
  applyHeaders({
    headers: createMcpDiscoveryPreflightHeaders(),
    set,
  });
  set.status = 204;
  return "";
};

export const createMcpRoute = ({
  handleMcpHttpRequest,
  limitAuthenticationFailure,
}: {
  handleMcpHttpRequest: HandleMcpHttpRequest;
  limitAuthenticationFailure?: ReturnType<
    typeof createMcpAuthenticationFailureLimiter
  >;
}) => {
  const handleMcpTransportRoute = async ({
    options,
    request,
    set,
  }: {
    options?: { clientIp?: string | null | undefined; mode?: McpMode };
    request: Request;
    set: RouteSet;
  }) => {
    dropCredentialedCors(set);

    if (!MCP_HTTP_METHODS.has(request.method)) {
      return new Response("Method Not Allowed", {
        headers: { Allow: MCP_HTTP_METHOD_ALLOW_HEADER },
        status: 405,
      });
    }

    if (!limitAuthenticationFailure) {
      return await handleMcpHttpRequest(request, options);
    }
    return await limitAuthenticationFailure({
      request,
      clientIp: options?.clientIp,
      run: async () => await handleMcpHttpRequest(request, options),
    });
  };

  // Discovery documents are public: routes take only the response schema,
  // because the handler config's `accountAccess` route macro requires a session.
  return new Elysia()
    .options(MCP_ADVANCED_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(MCP_ADVANCED_DISCOVERY_PATH, readAdvancedMetadata.handler, {
      response: readAdvancedMetadata.config.response,
    })
    .options(ROOT_MCP_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(ROOT_MCP_DISCOVERY_PATH, readDefaultMetadata.handler, {
      response: readDefaultMetadata.config.response,
    })
    .options(MCP_ANONYMIZED_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(MCP_ANONYMIZED_DISCOVERY_PATH, readAnonymizedMetadata.handler, {
      response: readAnonymizedMetadata.config.response,
    })
    .options(MCP_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(MCP_DISCOVERY_PATH, readDefaultMetadata.handler, {
      response: readDefaultMetadata.config.response,
    })
    .options(MCP_DOCUMENTS_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(MCP_DOCUMENTS_DISCOVERY_PATH, readDocumentsMetadata.handler, {
      response: readDocumentsMetadata.config.response,
    })
    .options(MCP_LAW_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(MCP_LAW_DISCOVERY_PATH, readLawMetadata.handler, {
      response: readLawMetadata.config.response,
    })
    .all(
      MCP_ADVANCED_HTTP_PATH,
      declareAggregateMutation(
        async ({
          request,
          server,
          set,
        }: Pick<Context, "request" | "server" | "set">) =>
          await handleMcpTransportRoute({
            options: {
              clientIp: resolveRateLimitClientAddress({
                request,
                server: server ?? null,
              }),
              mode: "advanced",
            },
            request,
            set,
          }),
        {
          type: "independent",
          reason:
            "MCP transport dispatches to capability handlers that own their aggregate mutations; the transport itself owns no aggregate state.",
        },
      ),
      { parse: "none" },
    )
    .all(
      MCP_HTTP_PATH,
      async ({ request, server, set }) =>
        await handleMcpTransportRoute({
          options: {
            clientIp: resolveRateLimitClientAddress({
              request,
              server: server ?? null,
            }),
          },
          request,
          set,
        }),
      // The MCP transports own JSON parsing. If Elysia parses first, the
      // web-standard Request reaches them with an already-consumed body and
      // every valid JSON-RPC POST is rejected as a parse error.
      { parse: "none" },
    )
    .all(
      MCP_DOCUMENTS_HTTP_PATH,
      async ({ request, server, set }) =>
        await handleMcpTransportRoute({
          options: {
            clientIp: resolveRateLimitClientAddress({
              request,
              server: server ?? null,
            }),
            mode: "documents",
          },
          request,
          set,
        }),
      { parse: "none" },
    )
    .all(
      MCP_ANONYMIZED_HTTP_PATH,
      async ({ request, server, set }) =>
        await handleMcpTransportRoute({
          options: {
            clientIp: resolveRateLimitClientAddress({
              request,
              server: server ?? null,
            }),
            mode: "anonymized",
          },
          request,
          set,
        }),
      { parse: "none" },
    )
    .all(
      MCP_LAW_HTTP_PATH,
      async ({ request, server, set }) =>
        await handleMcpTransportRoute({
          options: {
            clientIp: resolveRateLimitClientAddress({
              request,
              server: server ?? null,
            }),
            mode: "law",
          },
          request,
          set,
        }),
      { parse: "none" },
    );
};

const mcpRouteRegistry = createMcpRoute({
  handleMcpHttpRequest: () => new Response(null),
});

const classifyMcpTransportRequest = createRequestRouteClassifier({
  routes: mcpRouteRegistry.routes,
  staticRoutes: mcpRouteRegistry.router.static,
  strictPath: mcpRouteRegistry.config.strictPath,
  aot: mcpRouteRegistry.config.aot,
  classifyRoute: (route) => route.method === "ALL",
});

export const isMcpTransportRequest = (request: Request) =>
  classifyMcpTransportRequest(request).type === "included";
