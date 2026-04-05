import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { captureError } from "@/api/lib/analytics";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import type { McpSession } from "@/api/mcp/auth";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import {
  McpAuthenticationError,
  McpOrganizationAccessError,
} from "@/api/mcp/errors";
import {
  createMcpCorsHeaders,
  getMcpWwwAuthenticateHeader,
} from "@/api/mcp/metadata";
import {
  getMcpToolDefinition,
  handleMcpToolCall,
  listMcpTools,
} from "@/api/mcp/tools";

const MCP_SERVER_VERSION = "0.1.0";

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
  status,
}: {
  message: string;
  status: 401 | 403;
}) => {
  const headers = createMcpCorsHeaders();
  headers.set("WWW-Authenticate", getMcpWwwAuthenticateHeader());

  return new Response(message, {
    headers,
    status,
  });
};

const createMcpServer = async ({ session }: { session: McpSession }) => {
  const context = await resolveMcpSessionContext(session);

  // The low-level Server API accepts JSON Schema directly, which keeps the
  // MCP surface independent from the AI SDK tool generics used elsewhere.
  // eslint-disable-next-line typescript-eslint/no-deprecated
  const server = new Server(
    { name: "stella", version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listMcpTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const definition = getMcpToolDefinition(toolName);
    if (!definition) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
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
      toolName,
    });
  });

  return server;
};

export const handleMcpHttpRequest = async (
  request: Request,
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
      status: 401,
    });
  }

  let server: Awaited<ReturnType<typeof createMcpServer>> | undefined;
  let transport: WebStandardStreamableHTTPServerTransport | undefined;

  try {
    const session = await authenticateMcpRequest(token);
    server = await createMcpServer({ session });
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
        status: 403,
      });
    }

    if (!(error instanceof McpAuthenticationError)) {
      captureError(error, {
        phase: "transport",
        source: "mcp",
      });
    }

    return accessDeniedResponse({
      message: "Invalid or expired token",
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
