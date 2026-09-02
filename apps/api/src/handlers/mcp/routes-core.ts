import Elysia from "elysia";

import { resolveClientIp } from "@/api/lib/client-ip";
import {
  MCP_ANONYMIZED_DISCOVERY_PATH,
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_DISCOVERY_PATH,
  MCP_DOCUMENTS_DISCOVERY_PATH,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
  ROOT_MCP_DISCOVERY_PATH,
} from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";
import {
  createMcpDiscoveryPreflightHeaders,
  createMcpMetadataHeaders,
  createMcpPreflightHeaders,
  getMcpProtectedResourceMetadata,
} from "@/api/mcp/metadata";

type HandleMcpHttpRequest = (
  request: Request,
  options?: { clientIp?: string | null; mode?: McpMode },
) => Promise<Response>;

type RouteSet = {
  headers: Record<string, string | number | boolean | undefined>;
  status?: number | string;
};

const MCP_HTTP_METHOD_ALLOW_HEADER = "OPTIONS, GET, POST, DELETE";
const MCP_HTTP_METHODS = new Set(MCP_HTTP_METHOD_ALLOW_HEADER.split(", "));

const ALLOW_CREDENTIALS_HEADER = "access-control-allow-credentials";

/**
 * The global CORS layer stamps `Access-Control-Allow-Credentials: true` on every
 * response as a default header. MCP paths are bearer-authenticated and never
 * read cookies, and a browser refuses a credentialed request answered with
 * `Access-Control-Allow-Origin: *`, so the combination is dropped here. Matched
 * case-insensitively: the header comes from a plugin default, and a casing
 * change there must not silently restore the pairing browsers reject.
 */
const dropCredentialedCors = (set: RouteSet) => {
  set.headers = Object.fromEntries(
    Object.entries(set.headers).filter(
      ([key]) => key.toLowerCase() !== ALLOW_CREDENTIALS_HEADER,
    ),
  );
};

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
  [MCP_HTTP_PATH, createMcpPreflightHeaders],
  [MCP_ANONYMIZED_HTTP_PATH, createMcpPreflightHeaders],
  [MCP_DOCUMENTS_HTTP_PATH, createMcpPreflightHeaders],
  [ROOT_MCP_DISCOVERY_PATH, createMcpDiscoveryPreflightHeaders],
  [MCP_DISCOVERY_PATH, createMcpDiscoveryPreflightHeaders],
  [MCP_ANONYMIZED_DISCOVERY_PATH, createMcpDiscoveryPreflightHeaders],
  [MCP_DOCUMENTS_DISCOVERY_PATH, createMcpDiscoveryPreflightHeaders],
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
    headers: createMcpMetadataHeaders(),
    set,
  });
  set.status = 204;
  return "";
};

const discoveryHandler =
  (mode?: McpMode) =>
  ({ set }: { set: RouteSet }) => {
    applyHeaders({
      headers: createMcpMetadataHeaders(),
      set,
    });
    return getMcpProtectedResourceMetadata(mode);
  };

export const createMcpRoute = ({
  handleMcpHttpRequest,
}: {
  handleMcpHttpRequest: HandleMcpHttpRequest;
}) => {
  const handleMcpTransportRoute = async ({
    options,
    request,
    set,
  }: {
    options?: { clientIp?: string | null; mode?: McpMode };
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

    return await handleMcpHttpRequest(request, options);
  };

  return new Elysia()
    .options(ROOT_MCP_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(ROOT_MCP_DISCOVERY_PATH, discoveryHandler())
    .options(MCP_ANONYMIZED_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(MCP_ANONYMIZED_DISCOVERY_PATH, discoveryHandler("anonymized"))
    .options(MCP_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(MCP_DISCOVERY_PATH, discoveryHandler())
    .options(MCP_DOCUMENTS_DISCOVERY_PATH, discoveryOptionsHandler)
    .get(MCP_DOCUMENTS_DISCOVERY_PATH, discoveryHandler("documents"))
    .all(
      MCP_HTTP_PATH,
      async ({ request, server, set }) =>
        await handleMcpTransportRoute({
          options: { clientIp: resolveClientIp(request, server ?? null) },
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
            clientIp: resolveClientIp(request, server ?? null),
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
            clientIp: resolveClientIp(request, server ?? null),
            mode: "anonymized",
          },
          request,
          set,
        }),
      { parse: "none" },
    );
};
