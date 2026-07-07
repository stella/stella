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
  STELLA_CLI_LATEST_HEADER,
  STELLA_CLI_LATEST_VERSION,
  type McpMode,
} from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  McpAuthenticationError,
  McpOrganizationAccessError,
} from "@/api/mcp/errors";
import { getMcpInstructions } from "@/api/mcp/instructions";
import {
  createMcpCorsHeaders,
  getMcpWwwAuthenticateHeader,
} from "@/api/mcp/metadata";
import type { McpToolDefinition, ToolScope } from "@/api/mcp/tool-types";
import { closestToolNames, structuredErrorResult } from "@/api/mcp/tool-utils";

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

const withMcpCors = (response: Response) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of createMcpCorsHeaders()) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  // Rides on every MCP response (incl. the CLI's tools/list fetch) to feed the
  // @stll/cli update nudge; never touches the JSON-RPC payload.
  headers.set(STELLA_CLI_LATEST_HEADER, STELLA_CLI_LATEST_VERSION);

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

      const definition = await getMcpToolDefinition(toolName, context, mode);
      if (!definition) {
        // Suggest the closest names the caller can actually see (scope-filtered
        // list), so a typo resolves without leaking tools they lack access to.
        const visibleNames = (
          await listMcpTools(context, mode, session.scopes)
        ).map((tool) => tool.name);
        const suggestions = closestToolNames(toolName, visibleNames);
        return structuredErrorResult({
          code: "unknown_tool",
          message: `Unknown tool: ${toolName}`,
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

      return withMcpCors(response);
    } catch (error) {
      if (error instanceof McpOrganizationAccessError) {
        return accessDeniedResponse({
          message: "Forbidden",
          mode,
          status: 403,
        });
      }

      if (!(error instanceof McpAuthenticationError)) {
        captureError(error, {
          phase: "transport",
          mode,
          source: "mcp",
        });
      }

      return accessDeniedResponse({
        message: "Invalid or expired token",
        mode,
        status: 401,
      });
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
