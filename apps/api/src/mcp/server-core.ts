import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  Tool as McpTool,
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";

import type { McpSession } from "@/api/mcp/auth";
import {
  type McpMode,
  STELLA_MCP_ORGANIZATION_HEADER,
  STELLA_MCP_SCOPES_HEADER,
} from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  McpAuthenticationError,
  McpGatewayLoadError,
  McpOrganizationAccessError,
} from "@/api/mcp/errors";
import { getMcpInstructions } from "@/api/mcp/instructions";
import {
  createMcpCorsHeaders,
  getMcpWwwAuthenticateHeader,
} from "@/api/mcp/metadata";
import type { McpToolDefinition, ToolScope } from "@/api/mcp/tool-types";
import {
  closestToolNames,
  MCP_INTERNAL_ERROR_HINT,
  structuredErrorResult,
} from "@/api/mcp/tool-utils";

const MAX_TOOL_NAME_SUGGESTION_CHARS = 128;

const formatUnknownToolName = (toolName: string): string =>
  toolName.length <= MAX_TOOL_NAME_SUGGESTION_CHARS
    ? toolName
    : `${toolName.slice(0, MAX_TOOL_NAME_SUGGESTION_CHARS)}...`;

/** `missing_scope` envelope: the granted scopes do not include `scope`. */
const missingScopeResult = (scope: ToolScope): CallToolResult =>
  structuredErrorResult({
    code: "missing_scope",
    message: `Insufficient permissions. Required scope: ${scope}`,
    hint: `Grant the '${scope}' scope by re-running OAuth consent (CLI: 'stella auth login --scopes ${scope}'), then retry.`,
  });

type McpServerDependencies = {
  authenticateMcpRequest: (token: string, mode: McpMode) => Promise<McpSession>;
  captureError: (error: unknown, context?: Record<string, string>) => void;
  getMcpToolDefinition: (
    toolName: string,
    context: McpRequestContext,
    mode?: McpMode,
  ) => Promise<McpToolDefinition | undefined>;
  getMcpToolScopeHint: (
    toolName: string,
    mode?: McpMode,
  ) => ToolScope | undefined;
  handleMcpToolCall: ({
    args,
    context,
    mode,
    toolName,
  }: {
    args: Record<string, unknown>;
    context: McpRequestContext;
    mode?: McpMode;
    toolName: string;
  }) => Promise<CallToolResult>;
  listMcpTools: (
    context: McpRequestContext,
    mode?: McpMode,
    scopes?: readonly string[],
  ) => Promise<McpTool[]>;
  listMcpResources: (mode: McpMode) => Resource[];
  readMcpResource: (uri: string, mode: McpMode) => ReadResourceResult;
  resolveMcpSessionContext: (
    session: McpSession,
    options: { request: Request },
  ) => Promise<McpRequestContext>;
};

const MCP_SERVER_VERSION = "0.1.0";
const getMcpServerName = (mode: McpMode) =>
  mode === "anonymized" ? "stella (anonymized)" : "stella";

const extractBearerToken = (request: Request): string | undefined => {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
};

const withMcpCors = (response: Response, session?: McpSession) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of createMcpCorsHeaders()) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  // Echo the authenticated session's identity so a caller holding an opaque
  // machine API key (not a decodable JWT) can confirm which org and scopes it
  // resolves to. Scopes are space-delimited, matching the OAuth scope grammar.
  if (session) {
    headers.set(STELLA_MCP_ORGANIZATION_HEADER, session.organizationId);
    headers.set(STELLA_MCP_SCOPES_HEADER, session.scopes.join(" "));
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const accessDeniedResponse = ({
  message,
  mode,
  status,
}: {
  message: string;
  mode: McpMode;
  status: 401 | 403;
}) => {
  const headers = createMcpCorsHeaders();
  headers.set("WWW-Authenticate", getMcpWwwAuthenticateHeader(mode));

  return new Response(message, {
    headers,
    status,
  });
};

/** Hint (seconds) for a client to back off before retrying a transient fault. */
const MCP_RETRY_AFTER_SECONDS = 2;

/**
 * A server-side fault (token-verification infrastructure outage, a bug in
 * session resolution, or a transport failure) is not a bad token: it must not
 * carry `WWW-Authenticate` (which would trigger a re-consent loop) and must not
 * leak internals. A generic, retryable 5xx tells the client to back off and
 * retry; the real cause is captured for observability by the caller.
 */
const retryableServerErrorResponse = () => {
  const headers = createMcpCorsHeaders();
  headers.set("Retry-After", String(MCP_RETRY_AFTER_SECONDS));

  return new Response("Service temporarily unavailable", {
    headers,
    status: 503,
  });
};

/**
 * Generic, retryable tool-error envelope for an unexpected failure while
 * handling a `tools/call` (e.g. a gateway load fault surfaced before dispatch).
 * Details never reach the caller; they are captured at the failure site.
 */
const retryableToolErrorResult = (): CallToolResult =>
  structuredErrorResult({
    code: "internal_error",
    message:
      "The request could not be completed due to a temporary server error",
    retryable: true,
    hint: MCP_INTERNAL_ERROR_HINT,
  });

export const createMcpHttpRequestHandler = ({
  authenticateMcpRequest,
  captureError,
  getMcpToolDefinition,
  getMcpToolScopeHint,
  handleMcpToolCall,
  listMcpResources,
  listMcpTools,
  readMcpResource,
  resolveMcpSessionContext,
}: McpServerDependencies) => {
  const createMcpServer = async ({
    mode,
    request,
    session,
  }: {
    mode: McpMode;
    request: Request;
    session: McpSession;
  }) => {
    const context = await resolveMcpSessionContext(session, { request });

    // The low-level Server API accepts JSON Schema directly, which keeps the
    // MCP surface independent from the chat tool generics used elsewhere.
    // eslint-disable-next-line typescript-eslint/no-deprecated -- low-level Server is the intended "advanced use case" API per the SDK; McpServer would couple us to chat tool generics
    const server = new Server(
      { name: getMcpServerName(mode), version: MCP_SERVER_VERSION },
      {
        capabilities: { resources: {}, tools: {} },
        instructions: getMcpInstructions(mode),
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await listMcpTools(context, mode, session.scopes),
    }));

    // Resources are static, public, tenant-independent documents (the template
    // marker grammar today); the same set is served in both modes without a
    // per-tool scope gate. Every request already carries a valid session token.
    // The SDK accepts synchronous request handlers, and both resource reads are
    // synchronous, so neither needs an async wrapper.
    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: listMcpResources(mode),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, (resourceRequest) =>
      readMcpResource(resourceRequest.params.uri, mode),
    );

    server.setRequestHandler(CallToolRequestSchema, async (toolRequest) => {
      const toolName = toolRequest.params.name;
      const hintedScope = getMcpToolScopeHint(toolName, mode);
      if (hintedScope && !session.scopes.includes(hintedScope)) {
        return missingScopeResult(hintedScope);
      }

      // Resolving a dynamic-gateway tool reads the backing store. A load fault
      // (`McpGatewayLoadError`) must not collapse into `unknown_tool`: answer a
      // transient outage with a retryable `internal_error` so the caller retries
      // instead of treating the tool as gone. The underlying failure is captured
      // at the load site, so it is not re-captured here.
      let definition: McpToolDefinition | undefined;
      try {
        definition = await getMcpToolDefinition(toolName, context, mode);
      } catch (error) {
        // A gateway load fault is already captured at the load site; anything
        // else is unexpected here and must be captured before it degrades to a
        // generic retryable result.
        if (!(error instanceof McpGatewayLoadError)) {
          captureError(error, { phase: "tools/call", mode, source: "mcp" });
        }
        return retryableToolErrorResult();
      }
      if (!definition) {
        // Suggest the closest names the caller can actually see (scope-filtered
        // list), so a typo resolves without leaking tools they lack access to.
        const suggestions =
          toolName.length <= MAX_TOOL_NAME_SUGGESTION_CHARS
            ? closestToolNames(
                toolName,
                (await listMcpTools(context, mode, session.scopes)).map(
                  (tool) => tool.name,
                ),
              )
            : [];
        return structuredErrorResult({
          code: "unknown_tool",
          message: `Unknown tool: ${formatUnknownToolName(toolName)}`,
          hint:
            suggestions.length > 0
              ? `No such tool. Did you mean: ${suggestions.join(", ")}? Call tools/list for the full set.`
              : "No such tool. Call tools/list for the tools available to this session.",
        });
      }

      if (!session.scopes.includes(definition.scope)) {
        return missingScopeResult(definition.scope);
      }

      return await handleMcpToolCall({
        args: toolRequest.params.arguments ?? {},
        context,
        mode,
        toolName,
      });
    });

    return server;
  };

  return async (
    request: Request,
    { mode = "default" }: { mode?: McpMode } = {},
  ): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: createMcpCorsHeaders(),
        status: 204,
      });
    }

    const token = extractBearerToken(request);
    if (!token) {
      return accessDeniedResponse({
        message: "Missing Authorization header",
        mode,
        status: 401,
      });
    }

    let server: Awaited<ReturnType<typeof createMcpServer>> | undefined;
    let transport: WebStandardStreamableHTTPServerTransport | undefined;

    try {
      const session = await authenticateMcpRequest(token, mode);
      server = await createMcpServer({ mode, request, session });
      transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });

      await server.connect(transport);

      const response = await transport.handleRequest(request, {
        authInfo: {
          clientId: session.userId,
          scopes: session.scopes,
          token,
        },
      });

      return withMcpCors(response, session);
    } catch (error) {
      if (error instanceof McpOrganizationAccessError) {
        return accessDeniedResponse({
          message: "Forbidden",
          mode,
          status: 403,
        });
      }

      // Only a genuine token rejection gets a 401 + `WWW-Authenticate`. Anything
      // else (a token-verification infrastructure outage surfaced as
      // `McpTokenVerificationError`, a bug in session resolution, or a transport
      // fault) is a server-side problem, not a bad token: capture it and return
      // a retryable 5xx so the client backs off instead of dropping into a
      // re-consent loop.
      if (error instanceof McpAuthenticationError) {
        return accessDeniedResponse({
          message: "Invalid or expired token",
          mode,
          status: 401,
        });
      }

      captureError(error, {
        phase: "transport",
        mode,
        source: "mcp",
      });

      return retryableServerErrorResponse();
    } finally {
      if (transport) {
        await transport.close().catch(() => null);
      }
      if (server) {
        await server.close().catch(() => null);
      }
    }
  };
};
