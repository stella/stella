import {
  createMcpHandler,
  isLegacyRequest,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type {
  AuthInfo,
  CallToolResult,
  McpHttpHandler,
  Tool as McpTool,
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/server";
import { panic } from "better-result";

import { detached } from "@/api/lib/detached";
import { isMcpSession, type McpSession } from "@/api/mcp/auth";
import {
  MCP_NOTIFICATION_KEEP_ALIVE_MS,
  MCP_STATELESS_ALLOW_HEADER,
  type McpMode,
  STELLA_MCP_ORGANIZATION_HEADER,
  STELLA_MCP_SCOPE_OMITTED_TOOLS_HEADER,
  STELLA_MCP_SCOPES_HEADER,
} from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  McpAuthenticationError,
  McpGatewayLoadError,
  McpOrganizationAccessError,
} from "@/api/mcp/errors";
import { isMcpToolFeatureEnabled } from "@/api/mcp/gateway/list-tools";
import { getMcpInstructions } from "@/api/mcp/instructions";
import {
  createMcpCorsHeaders,
  getMcpWwwAuthenticateHeader,
} from "@/api/mcp/metadata";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition, ToolScope } from "@/api/mcp/tool-types";
import {
  closestToolNames,
  MCP_INTERNAL_ERROR_HINT,
  oauthScopeRecoveryHint,
  serializeToolResult,
  structuredErrorResult,
} from "@/api/mcp/tool-utils";

const MAX_TOOL_NAME_SUGGESTION_CHARS = 128;

const mcpStructuredErrorResult = (
  args: Parameters<typeof structuredErrorResult>[0],
): CallToolResult => serializeToolResult(structuredErrorResult(args));

type ByteStreamReadResult =
  | { done: false; value: Uint8Array }
  | { done: true; value?: undefined };

const isByteStreamReadResult = (
  value: unknown,
): value is ByteStreamReadResult => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { done, value: chunk }: Record<string, unknown> = { ...value };
  return done === true
    ? chunk === undefined
    : done === false && chunk instanceof Uint8Array;
};

const takeStreamReaderOwnership = <T>(body: ReadableStream<T>) =>
  body.getReader();

const formatUnknownToolName = (toolName: string): string =>
  toolName.length <= MAX_TOOL_NAME_SUGGESTION_CHARS
    ? toolName
    : `${toolName.slice(0, MAX_TOOL_NAME_SUGGESTION_CHARS)}...`;

/** `missing_scope` envelope with a CLI command that preserves all grants. */
const missingScopeResult = ({
  grantedScopes,
  missingScope,
  requiredScopes,
}: {
  grantedScopes: readonly string[];
  missingScope: ToolScope;
  requiredScopes: readonly ToolScope[];
}): CallToolResult =>
  mcpStructuredErrorResult({
    code: "missing_scope",
    message: `Insufficient permissions. Required scope: ${missingScope}`,
    hint: oauthScopeRecoveryHint({
      grantedScopes,
      missingScope,
      requiredScopes,
    }),
  });

const requiredScopesForTool = (
  definition: McpToolDefinition,
): readonly ToolScope[] => {
  if (definition.additionalScopes === undefined) {
    return [definition.scope];
  }
  return [definition.scope, ...definition.additionalScopes];
};

type McpServerDependencies = {
  authenticateMcpRequest: (
    token: string,
    options: { mode: McpMode },
  ) => Promise<McpSession>;
  captureError: (error: unknown, context?: Record<string, string>) => void;
  getMcpToolDefinition: (
    toolName: string,
    context: McpRequestContext,
    mode?: McpMode,
  ) => Promise<McpToolDefinition | undefined>;
  getMcpToolRequiredScopesHint: (
    toolName: string,
    mode?: McpMode,
  ) => readonly ToolScope[] | undefined;
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
  readMcpResource: (
    uri: string,
    mode: McpMode,
  ) => ReadResourceResult | Promise<ReadResourceResult>;
  resolveMcpSessionContext: (
    session: McpSession,
    options: { clientIp?: string | null; request: Request },
  ) => Promise<McpRequestContext>;
};

const MCP_SERVER_VERSION = "0.1.0";
const getMcpServerName = (mode: McpMode) => {
  if (mode === "anonymized") {
    return "stella (anonymized)";
  }
  if (mode === "documents") {
    return "stella (documents)";
  }
  return "stella";
};

const extractBearerToken = (request: Request): string | undefined => {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
};

const scopeOmittedCompoundToolNames = (
  session: McpSession,
  mode: McpMode,
): readonly string[] =>
  listStaticMcpToolDefinitions(mode)
    .filter(
      (definition) =>
        definition.additionalScopes !== undefined &&
        definition.additionalScopes.length > 0 &&
        isMcpToolFeatureEnabled(definition.feature) &&
        !session.scopes.includes(definition.scope),
    )
    .map((definition) => definition.name)
    .sort();

const withMcpCors = (
  response: Response,
  session?: McpSession,
  mode: McpMode = "default",
) => {
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
    headers.set(
      STELLA_MCP_SCOPE_OMITTED_TOOLS_HEADER,
      scopeOmittedCompoundToolNames(session, mode).join(" "),
    );
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

const sessionOperationUnsupportedResponse = () => {
  const headers = createMcpCorsHeaders();
  headers.set("Allow", MCP_STATELESS_ALLOW_HEADER);
  headers.set("Content-Type", "application/json");

  return new Response(
    JSON.stringify({
      error: {
        code: -32_000,
        message: "Method Not Allowed: this endpoint serves no session.",
      },
      id: null,
      jsonrpc: "2.0",
    }),
    { headers, status: 405 },
  );
};

/**
 * The handler factory receives only `{ era, authInfo, requestInfo }`, and auth
 * is strictly pass-through, so the session we already resolved rides along on
 * `authInfo.extra` under a namespaced key. The value is ours from a few
 * microseconds earlier, not caller input: a missing or malformed one is a wiring
 * bug, so it panics rather than degrading to an unauthenticated instance.
 */
const FACTORY_STATE_KEY = "app.stll.mcp/factory-state";

type McpFactoryState = {
  clientIp: string | null;
  session: McpSession;
};

const isMcpFactoryState = (value: unknown): value is McpFactoryState => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { clientIp, session }: Record<string, unknown> = { ...value };
  return (
    (clientIp === null || typeof clientIp === "string") && isMcpSession(session)
  );
};

const readFactoryState = (
  extra: Record<string, unknown> | undefined,
): McpFactoryState => {
  const state = extra?.[FACTORY_STATE_KEY];
  if (!isMcpFactoryState(state)) {
    panic("The MCP handler factory ran without its per-request session state");
  }
  return state;
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
  mcpStructuredErrorResult({
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
  getMcpToolRequiredScopesHint,
  handleMcpToolCall,
  listMcpResources,
  listMcpTools,
  readMcpResource,
  resolveMcpSessionContext,
}: McpServerDependencies) => {
  const createMcpServer = async ({
    clientIp,
    mode,
    request,
    session,
  }: {
    clientIp: string | null;
    mode: McpMode;
    request: Request;
    session: McpSession;
  }) => {
    const context = await resolveMcpSessionContext(session, {
      clientIp,
      request,
    });

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

    server.setRequestHandler("tools/list", async () => ({
      tools: await listMcpTools(context, mode, session.scopes),
    }));

    // Resources are static, public, tenant-independent documents (the template
    // marker grammar today); the same set is served in both modes without a
    // per-tool scope gate. Every request already carries a valid session token.
    server.setRequestHandler("resources/list", () => ({
      resources: listMcpResources(mode),
    }));

    server.setRequestHandler(
      "resources/read",
      async (resourceRequest) =>
        await readMcpResource(resourceRequest.params.uri, mode),
    );

    server.setRequestHandler("tools/call", async (toolRequest) => {
      const toolName = toolRequest.params.name;
      const requiredScopesHint = getMcpToolRequiredScopesHint(toolName, mode);
      const missingHintedScope = requiredScopesHint?.find(
        (scope) => !session.scopes.includes(scope),
      );
      if (
        missingHintedScope !== undefined &&
        requiredScopesHint !== undefined
      ) {
        return missingScopeResult({
          grantedScopes: session.scopes,
          missingScope: missingHintedScope,
          requiredScopes: requiredScopesHint,
        });
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
        return mcpStructuredErrorResult({
          code: "unknown_tool",
          message: `Unknown tool: ${formatUnknownToolName(toolName)}`,
          hint:
            suggestions.length > 0
              ? `No such tool. Did you mean: ${suggestions.join(", ")}? Call tools/list for the full set.`
              : "No such tool. Call tools/list for the tools available to this session.",
        });
      }

      const requiredScopes = requiredScopesForTool(definition);
      const missingScope = requiredScopes.find(
        (scope) => !session.scopes.includes(scope),
      );
      if (missingScope !== undefined) {
        return missingScopeResult({
          grantedScopes: session.scopes,
          missingScope,
          requiredScopes,
        });
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

  // One handler per mode, built once. The handler owns per-request instance
  // lifetime; building one per request would put teardown back on our side of
  // the boundary, which is the mistake this replaces.
  //
  // `legacy: "reject"` because the built-in fallback answers 2025-era requests
  // with an SSE stream, and this endpoint has always answered them with a
  // single JSON body. Published CLI releases parse that body as JSON, so the
  // shape is a compatibility promise, not an implementation detail; legacy
  // traffic is served below instead.
  const handlers = new Map<McpMode, McpHttpHandler>();
  const handlerForMode = (mode: McpMode): McpHttpHandler => {
    const existing = handlers.get(mode);
    if (existing) {
      return existing;
    }

    const handler = createMcpHandler(
      async ({ authInfo, requestInfo }) => {
        const { clientIp, session } = readFactoryState(authInfo?.extra);
        if (!requestInfo) {
          panic("The MCP handler factory ran without its HTTP request");
        }
        return createMcpServer({
          clientIp,
          mode,
          request: requestInfo,
          session,
        });
      },
      {
        legacy: "reject",
        // The v2 handler converts factory/dispatch exceptions into responses
        // internally, so they never reach the outer transport catch. Preserve
        // the endpoint's observability contract through the handler's reporting
        // hook; the response is normalized to the retryable contract below.
        onerror: (error) => {
          captureError(error, { phase: "transport", mode, source: "mcp" });
        },
      },
    );
    handlers.set(mode, handler);
    return handler;
  };

  /**
   * The 2025-era leg uses a fresh server and transport for every request. POST
   * responses are buffered and can be torn down immediately. GET is different:
   * ChatGPT opens the optional notification channel and treats a 405 as a dead
   * connector, so its server and transport live exactly as long as the returned
   * SSE body. No state is shared between that channel and later POST requests.
   */
  const serveLegacyRequest = async ({
    authInfo,
    clientIp,
    mode,
    request,
    session,
  }: {
    authInfo: AuthInfo;
    clientIp: string | null;
    mode: McpMode;
    request: Request;
    session: McpSession;
  }): Promise<Response> => {
    const server = await createMcpServer({ clientIp, mode, request, session });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      keepAliveMs: MCP_NOTIFICATION_KEEP_ALIVE_MS,
    });
    const reportTransportError = (error: unknown, operation: string) => {
      captureError(error, {
        mode,
        operation,
        phase: "transport",
        source: "mcp",
      });
    };

    let toreDown = false;
    const teardown = async () => {
      if (toreDown) {
        return;
      }
      toreDown = true;
      const [transportResult, serverResult] = await Promise.allSettled([
        transport.close(),
        server.close(),
      ]);
      if (transportResult.status === "rejected") {
        reportTransportError(transportResult.reason, "close_transport");
      }
      if (serverResult.status === "rejected") {
        reportTransportError(serverResult.reason, "close_server");
      }
    };

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request, { authInfo });
      const isEventStream =
        response.headers
          .get("content-type")
          ?.split(";")
          .at(0)
          ?.trim()
          .toLowerCase() === "text/event-stream";

      if (response.body === null || !isEventStream) {
        await teardown();
        return response;
      }

      const reader = takeStreamReaderOwnership(response.body);
      let readerReleased = false;
      const completeExchange = async () => {
        request.signal.removeEventListener("abort", abortExchange);
        if (!readerReleased) {
          reader.releaseLock();
          readerReleased = true;
        }
        await teardown();
      };
      const abortExchange = () => {
        detached(
          (async () => {
            try {
              await reader.cancel(request.signal.reason);
            } catch (error) {
              reportTransportError(error, "cancel_stream");
            } finally {
              await completeExchange();
            }
          })(),
          "mcp.legacy-stream-teardown",
        );
      };
      request.signal.addEventListener("abort", abortExchange, {
        once: true,
      });

      // A pull is suspended across the upstream read and the teardown that
      // follows it, and the consumer can cancel `monitoredBody` during either
      // await. Cancelling closes the controller, so the close/enqueue that
      // resumes afterwards throws, and the catch below would report that as a
      // failed transport read. A cancelled body is a normal end of the
      // exchange, so absorb the closed-controller throw here, the way the SSE
      // connection registries do, and leave the catch for real read failures.
      const closeMonitoredBody = (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ): void => {
        try {
          controller.close();
        } catch {
          // Already closed by a concurrent cancel.
        }
      };
      const enqueueMonitoredChunk = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        chunk: Uint8Array,
      ): void => {
        try {
          controller.enqueue(chunk);
        } catch {
          // Already closed by a concurrent cancel.
        }
      };

      const monitoredBody = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          if (readerReleased) {
            closeMonitoredBody(controller);
            return;
          }
          try {
            const readResult: unknown = await reader.read();
            if (!isByteStreamReadResult(readResult)) {
              throw new TypeError("MCP transport returned a non-byte stream");
            }
            if (readResult.done) {
              await completeExchange();
              closeMonitoredBody(controller);
              return;
            }
            enqueueMonitoredChunk(controller, readResult.value);
          } catch (error) {
            reportTransportError(error, "read_stream");
            await completeExchange();
            controller.error(error);
          }
        },
        cancel: async (reason) => {
          try {
            await reader.cancel(reason);
          } catch (error) {
            reportTransportError(error, "cancel_stream");
          } finally {
            await completeExchange();
          }
        },
      });

      return new Response(monitoredBody, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (error) {
      await teardown();
      throw error;
    }
  };

  return async (
    request: Request,
    {
      clientIp = null,
      mode = "default",
    }: { clientIp?: string | null; mode?: McpMode } = {},
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

    try {
      const session = await authenticateMcpRequest(token, { mode });

      // Refuse session termination only after the token is accepted, so an
      // unauthenticated probe still receives the 401 + `WWW-Authenticate` that
      // drives OAuth discovery.
      if (request.method === "DELETE") {
        return withMcpCors(
          sessionOperationUnsupportedResponse(),
          session,
          mode,
        );
      }

      const authInfo = {
        clientId: session.userId,
        extra: { [FACTORY_STATE_KEY]: { clientIp, session } },
        scopes: session.scopes,
        token,
      };
      const legacyRequest = await isLegacyRequest(request);
      const response = legacyRequest
        ? await serveLegacyRequest({
            authInfo,
            clientIp,
            mode,
            request,
            session,
          })
        : await handlerForMode(mode).fetch(request, { authInfo });

      // `createMcpHandler` owns and catches modern exchange failures. Restore
      // the public retry contract the outer catch provides on the legacy leg.
      if (!legacyRequest && response.status >= 500) {
        return retryableServerErrorResponse();
      }

      return withMcpCors(response, session, mode);
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
    }
    // No teardown here on purpose. The handler owns instance lifetime and a
    // response body may still be streaming when this returns; closing it here
    // is what truncated the notification stream under the hand-wired transport.
  };
};
