import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import type { McpSession } from "@/api/mcp/auth";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  McpAuthenticationError,
  McpOrganizationAccessError,
} from "@/api/mcp/errors";
import {
  createMcpCorsHeaders,
  getMcpWwwAuthenticateHeader,
} from "@/api/mcp/metadata";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

type McpServerDependencies = {
  authenticateMcpRequest: (token: string, mode: McpMode) => Promise<McpSession>;
  captureError: (error: unknown, context?: Record<string, string>) => void;
  getMcpToolDefinition: (
    toolName: string,
    mode?: McpMode,
  ) => McpToolDefinition | undefined;
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
  listMcpTools: (mode?: McpMode) => McpTool[];
  resolveMcpSessionContext: (session: McpSession) => Promise<McpRequestContext>;
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
  handleMcpToolCall,
  listMcpTools,
  resolveMcpSessionContext,
}: McpServerDependencies) => {
  const createMcpServer = async ({
    mode,
    session,
  }: {
    mode: McpMode;
    session: McpSession;
  }) => {
    const context = await resolveMcpSessionContext(session);

    // The low-level Server API accepts JSON Schema directly, which keeps the
    // MCP surface independent from the AI SDK tool generics used elsewhere.
    // eslint-disable-next-line typescript-eslint/no-deprecated
    const server = new Server(
      { name: getMcpServerName(mode), version: MCP_SERVER_VERSION },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: listMcpTools(mode),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const definition = getMcpToolDefinition(toolName, mode);
      if (!definition) {
        return {
          content: [
            { type: "text" as const, text: `Unknown tool: ${toolName}` },
          ],
          isError: true,
        };
      }

      if (!session.scopes.includes(definition.scope)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Insufficient permissions. Required scope: ${definition.scope}`,
            },
          ],
          isError: true,
        };
      }

      return await handleMcpToolCall({
        args: request.params.arguments ?? {},
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
      server = await createMcpServer({ mode, session });
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
