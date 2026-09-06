import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  Tool as McpTool,
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/server";
import { panic } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  resetAnalyticsForTesting,
  setAnalyticsForTesting,
} from "@/api/lib/analytics/client";
import type { ServerAnalyticsCaptureParams } from "@/api/lib/analytics/types";
import { recordMcpSessionInitialized } from "@/api/mcp/client-identity";
import {
  MCP_ALL_RESOURCE_SCOPES,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_STATELESS_ALLOW_HEADER,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";
import {
  McpAuthenticationError,
  McpGatewayLoadError,
  McpOrganizationAccessError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import {
  createMcpHttpRequestHandler,
  mcpOmittedToolNamesByReason,
} from "@/api/mcp/server-core";
import {
  DOCUMENTS_MCP_TOOL_DEFINITIONS,
  listStaticMcpToolDefinitions,
} from "@/api/mcp/static-tool-definitions";
import type { ToolScope } from "@/api/mcp/tool-types";
import { readTestJson } from "@/api/tests/helpers/test-tool-set";

const authenticateMcpRequestMock = mock();
const captureErrorMock = mock();
const resolveMcpSessionContextMock = mock();
const getMcpToolDefinitionMock = mock();
const getMcpToolRequiredScopesHintMock = mock(
  (_toolName: string): readonly ToolScope[] | undefined => undefined,
);
const handleMcpToolCallMock = mock();
const listMcpToolsMock = mock(
  async (
    _context?: unknown,
    _mode?: unknown,
    _scopes?: unknown,
  ): Promise<McpTool[]> => [],
);
const listMcpResourcesMock = mock((): Resource[] => []);
const readMcpResourceMock = mock((): ReadResourceResult => ({ contents: [] }));

const handleMcpHttpRequest = createMcpHttpRequestHandler({
  authenticateMcpRequest: authenticateMcpRequestMock,
  captureError: (error, context) => {
    captureErrorMock(error, context);
  },
  getMcpToolDefinition: getMcpToolDefinitionMock,
  getMcpToolRequiredScopesHint: getMcpToolRequiredScopesHintMock,
  handleMcpToolCall: handleMcpToolCallMock,
  listMcpResources: listMcpResourcesMock,
  listMcpTools: listMcpToolsMock,
  readMcpResource: readMcpResourceMock,
  // The real recorder, so the assertions below cover the sanitization it
  // applies rather than a fake's idea of it; its analytics sink is replaced
  // per test through the module's own seam.
  recordMcpSessionInitialized,
  resolveMcpSessionContext: resolveMcpSessionContextMock,
});

const createMcpRequest = (body: unknown) =>
  new Request("http://localhost/mcp", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer token",
      "content-type": "application/json",
    },
    method: "POST",
  });

const MODERN_PROTOCOL_VERSION = "2026-07-28";

const createModernMcpRequest = ({
  id,
  method,
  params = {},
  token = "token",
}: {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  token?: string;
}) =>
  new Request("http://localhost/mcp", {
    body: JSON.stringify({
      id,
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: "stella-test", version: "1.0.0" },
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        },
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    },
    method: "POST",
  });

type UnknownToolErrorEnvelope = {
  error: {
    code: string;
    hint: string;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseUnknownToolErrorEnvelope = (
  text: string,
): UnknownToolErrorEnvelope | undefined => {
  const payload: unknown = JSON.parse(text);
  if (!isRecord(payload)) {
    return undefined;
  }
  const error = payload["error"];
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error["code"];
  const hint = error["hint"];
  if (typeof code !== "string" || typeof hint !== "string") {
    return undefined;
  }
  return { error: { code, hint } };
};

type McpJsonResponse<TResult> = {
  id: number;
  jsonrpc: "2.0";
  result: TResult;
};

type McpJsonRpcError = {
  error: { code: number; message: string };
  id: null;
  jsonrpc: "2.0";
};

describe("handleMcpHttpRequest", () => {
  beforeEach(() => {
    authenticateMcpRequestMock.mockReset();
    captureErrorMock.mockReset();
    getMcpToolDefinitionMock.mockReset();
    getMcpToolRequiredScopesHintMock.mockReset();
    getMcpToolRequiredScopesHintMock.mockImplementation(
      (_toolName: string): readonly ToolScope[] | undefined => undefined,
    );
    handleMcpToolCallMock.mockReset();
    listMcpToolsMock.mockReset();
    listMcpToolsMock.mockImplementation(async () => []);
    listMcpResourcesMock.mockReset();
    listMcpResourcesMock.mockImplementation(() => []);
    readMcpResourceMock.mockReset();
    readMcpResourceMock.mockImplementation(() => ({ contents: [] }));
    resolveMcpSessionContextMock.mockReset();
    resetAnalyticsForTesting();
  });

  test("returns a generic 401 for token validation failures", async () => {
    authenticateMcpRequestMock.mockRejectedValue(
      new McpAuthenticationError({
        message: "Token missing org_id claim",
      }),
    );

    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", {
        headers: {
          authorization: "Bearer token",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(await readTestJson<McpJsonRpcError>(response)).toEqual({
      error: { code: -32_001, message: "Invalid or expired token" },
      id: null,
      jsonrpc: "2.0",
    });
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("returns a generic 403 for organization access failures", async () => {
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockRejectedValue(
      new McpOrganizationAccessError({
        message: "User is not a member of this organization",
      }),
    );
    const mcpRequest = new Request("http://localhost/mcp", {
      headers: {
        authorization: "Bearer token",
      },
      method: "POST",
    });

    const response = await handleMcpHttpRequest(mcpRequest);

    expect(response.status).toBe(403);
    expect(await readTestJson<McpJsonRpcError>(response)).toEqual({
      error: { code: -32_001, message: "Forbidden" },
      id: null,
      jsonrpc: "2.0",
    });
    expect(resolveMcpSessionContextMock).toHaveBeenCalledWith(
      {
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      },
      { clientIp: null, request: mcpRequest },
    );
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("captures unexpected transport errors as a retryable 5xx, not a 401", async () => {
    const error = new Error("database connection refused");
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockRejectedValue(error);

    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", {
        headers: {
          authorization: "Bearer token",
        },
        method: "POST",
      }),
    );

    // A server-side bug must not present to the client as a bad token (which
    // would trigger a pointless re-consent loop): no 401, no WWW-Authenticate.
    expect(response.status).toBe(503);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(captureErrorMock).toHaveBeenCalledWith(error, {
      mode: "default",
      phase: "transport",
      source: "mcp",
    });
  });

  test("captures modern handler failures and preserves the retryable transport contract", async () => {
    const error = new Error("database connection refused");
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockRejectedValue(error);

    const response = await handleMcpHttpRequest(
      createModernMcpRequest({ id: 1, method: "tools/list" }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(captureErrorMock).toHaveBeenCalledWith(error, {
      mode: "default",
      phase: "transport",
      source: "mcp",
    });
  });

  test("builds a fresh modern server for each authenticated session", async () => {
    authenticateMcpRequestMock.mockImplementation((token: string) => ({
      organizationId: token === "first" ? "org_1" : "org_2",
      scopes: ["stella:read"],
      userId: token === "first" ? "user_1" : "user_2",
    }));
    resolveMcpSessionContextMock.mockImplementation(
      (session: { organizationId: string }) => ({
        organizationId: session.organizationId,
      }),
    );
    listMcpToolsMock.mockImplementation(async (context?: unknown) => {
      if (!isRecord(context) || typeof context["organizationId"] !== "string") {
        throw new Error("Expected an organization-scoped MCP context");
      }
      return [
        {
          description: "Tenant-specific tool",
          inputSchema: { properties: {}, type: "object" },
          name: `tool_for_${context["organizationId"]}`,
        },
      ];
    });

    const responses = await Promise.all([
      handleMcpHttpRequest(
        createModernMcpRequest({ id: 1, method: "tools/list", token: "first" }),
      ),
      handleMcpHttpRequest(
        createModernMcpRequest({
          id: 2,
          method: "tools/list",
          token: "second",
        }),
      ),
    ]);
    const bodies = await Promise.all(
      responses.map(
        async (response) =>
          await readTestJson<McpJsonResponse<{ tools: McpTool[] }>>(response),
      ),
    );

    expect(resolveMcpSessionContextMock).toHaveBeenCalledTimes(2);
    expect(bodies.map((body) => body.result.tools.at(0)?.name)).toEqual([
      "tool_for_org_1",
      "tool_for_org_2",
    ]);
    expect(listMcpToolsMock).toHaveBeenCalledWith(
      { organizationId: "org_1" },
      "default",
      ["stella:read"],
    );
    expect(listMcpToolsMock).toHaveBeenCalledWith(
      { organizationId: "org_2" },
      "default",
      ["stella:read"],
    );
  });

  test("the official v2 client separates host-file upload from the picker app", async () => {
    const context = { type: "documents-mcp-context" };
    const definitions = DOCUMENTS_MCP_TOOL_DEFINITIONS.filter(({ name }) =>
      ["upload_document_version", "open_document_version_upload"].includes(
        name,
      ),
    );
    if (definitions.length !== 2) {
      panic("Canonical upload and picker tool definitions are missing");
    }

    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read", "stella:documents_write", "stella:matters_write"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    listMcpToolsMock.mockResolvedValue(toMcpTools(definitions));
    getMcpToolRequiredScopesHintMock.mockReturnValue([
      "stella:documents_write",
    ]);
    getMcpToolDefinitionMock.mockImplementation(async (toolName: string) =>
      definitions.find(({ name }) => name === toolName),
    );
    handleMcpToolCallMock.mockImplementation(
      async ({ toolName }: { toolName: string }) =>
        toolName === "upload_document_version"
          ? {
              content: [{ type: "text", text: "Uploaded document version." }],
              structuredContent: { entityVersionId: "version_1" },
            }
          : {
              content: [
                { type: "text", text: "Choose a file in the upload panel." },
              ],
              structuredContent: {
                entityId: "00000000-0000-4000-8000-0000000e0001",
                workspaceId: "workspace_1",
              },
            },
    );

    const transportFetch: FetchLike = async (input, init) =>
      await handleMcpHttpRequest(new Request(input.toString(), init), {
        mode: "documents",
      });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp-documents"),
      {
        fetch: transportFetch,
        requestInit: { headers: { authorization: "Bearer token" } },
      },
    );
    const client = new Client({ name: "stella-e2e-test", version: "1.0.0" });

    try {
      await client.connect(transport, { timeout: 2000 });
      const listed = await client.listTools(undefined, { timeout: 2000 });
      const uploadTool = listed.tools.find(
        ({ name }) => name === "upload_document_version",
      );
      const pickerTool = listed.tools.find(
        ({ name }) => name === "open_document_version_upload",
      );

      expect(uploadTool?._meta).toMatchObject({
        "openai/fileParams": ["file"],
      });
      expect(uploadTool?._meta).not.toHaveProperty("ui");
      expect(pickerTool?._meta).toMatchObject({
        ui: { resourceUri: "ui://stella/document-version-upload" },
      });
      const uploaded = await client.callTool(
        {
          name: "upload_document_version",
          arguments: {
            entity_id: "00000000-0000-4000-8000-0000000e0001",
            file: {
              download_url: "https://files.example/agreement.docx",
              file_id: "file_1",
              file_name: "agreement.docx",
              mime_type:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
          },
        },
        { timeout: 2000 },
      );
      expect(uploaded.structuredContent).toEqual({
        entityVersionId: "version_1",
      });
      const opened = await client.callTool(
        {
          name: "open_document_version_upload",
          arguments: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
        },
        { timeout: 2000 },
      );
      expect(opened.structuredContent).toEqual({
        entityId: "00000000-0000-4000-8000-0000000e0001",
        workspaceId: "workspace_1",
      });
      expect(authenticateMcpRequestMock).toHaveBeenCalledWith("token", {
        mode: "documents",
      });
      expect(listMcpToolsMock).toHaveBeenCalledWith(context, "documents", [
        "stella:read",
        "stella:documents_write",
        "stella:matters_write",
      ]);
      expect(handleMcpToolCallMock.mock.calls).toEqual([
        [
          {
            args: {
              entity_id: "00000000-0000-4000-8000-0000000e0001",
              file: {
                download_url: "https://files.example/agreement.docx",
                file_id: "file_1",
                file_name: "agreement.docx",
                mime_type:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              },
            },
            context,
            mode: "documents",
            toolName: "upload_document_version",
          },
        ],
        [
          {
            args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
            context,
            mode: "documents",
            toolName: "open_document_version_upload",
          },
        ],
      ]);
    } finally {
      await client.close();
    }
  });

  test("captures a token-verification infrastructure outage as a retryable 5xx, not a 401", async () => {
    const error = new McpTokenVerificationError({
      message: "Token verification is temporarily unavailable",
      cause: new Error("Jwks failed: fetch failed"),
    });
    authenticateMcpRequestMock.mockRejectedValue(error);

    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", {
        headers: {
          authorization: "Bearer token",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(captureErrorMock).toHaveBeenCalledWith(error, {
      mode: "default",
      phase: "transport",
      source: "mcp",
    });
  });

  test("keeps the authenticated notification stream open until the client cancels", async () => {
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue({ type: "mcp-context" });

    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", {
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer token",
        },
        method: "GET",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = response.body;
    expect(body).not.toBeNull();
    if (body === null) {
      throw new Error("Expected an authenticated notification stream");
    }

    const reader = body.getReader();
    const firstRead = reader.read();
    const initialState = await Promise.race([
      firstRead.then(({ done }) =>
        done ? ("ended" as const) : ("open" as const),
      ),
      Bun.sleep(20).then(() => "open" as const),
    ]);
    expect(initialState).toBe("open");

    await reader.cancel();
    await firstRead;
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("refuses session termination with 405", async () => {
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });

    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", {
        headers: { authorization: "Bearer token" },
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe(MCP_STATELESS_ALLOW_HEADER);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(resolveMcpSessionContextMock).not.toHaveBeenCalled();
  });

  test("keeps an unauthenticated GET on the 401 discovery path", async () => {
    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", { method: "GET" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).not.toBeNull();
    expect(authenticateMcpRequestMock).not.toHaveBeenCalled();
  });

  test("records the initializing client once, under a capped identity", async () => {
    const captured: ServerAnalyticsCaptureParams[] = [];
    setAnalyticsForTesting({
      capture: (params) => {
        captured.push(params);
      },
      identifyOrganizationGroup: () => undefined,
      flush: async () => await Promise.resolve(),
    });
    authenticateMcpRequestMock.mockResolvedValue({
      credential: { clientId: "client_1", type: "oauth_client" },
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue({ type: "mcp-context" });

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: `  ${"n".repeat(200)}  `, version: "1.2.3" },
          protocolVersion: "2025-06-18",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(captured).toEqual([
      {
        distinctId: "user_1",
        event: "mcp_session_initialized",
        groups: { organization: "org_1" },
        properties: {
          client_name: "n".repeat(128),
          client_version: "1.2.3",
          credential_type: "oauth_client",
          mode: "default",
        },
      },
    ]);

    // One event per handshake, not per request: a later call on the same
    // credentials carries no new client identity to record.
    await handleMcpHttpRequest(
      createMcpRequest({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
    );

    expect(captured).toHaveLength(1);
  });

  test("serves the handshake when the analytics sink throws", async () => {
    const sinkFailure = new Error("analytics sink unavailable");
    setAnalyticsForTesting({
      capture: () => {
        throw sinkFailure;
      },
      identifyOrganizationGroup: () => undefined,
      flush: async () => await Promise.resolve(),
    });
    authenticateMcpRequestMock.mockResolvedValue({
      credential: { clientId: "client_1", type: "oauth_client" },
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue({ type: "mcp-context" });

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "claude-ai", version: "1.2.3" },
          protocolVersion: "2025-06-18",
        },
      }),
    );

    // Telemetry is not part of the protocol contract: a failed capture is
    // reported, and the client still completes its handshake.
    expect(response.status).toBe(200);
    expect(captureErrorMock).toHaveBeenCalledWith(sinkFailure, {
      mode: "default",
      phase: "initialize",
      source: "mcp",
    });
  });

  test("keeps POST buffered and DELETE non-streaming", async () => {
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue({ type: "mcp-context" });

    const requests = [
      createMcpRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      new Request("http://localhost/mcp", {
        headers: { authorization: "Bearer token" },
        method: "DELETE",
      }),
    ];

    const responses = await Promise.all(
      requests.map(async (request) => await handleMcpHttpRequest(request)),
    );

    for (const response of responses) {
      const contentType = response.headers.get("content-type") ?? "";

      expect(contentType).not.toContain("text/event-stream");
    }
  });

  test("answers a gateway load fault during tools/call with a retryable internal_error, not unknown_tool", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read", "stella:skills"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    getMcpToolRequiredScopesHintMock.mockReturnValue(undefined);
    // The dynamic-gateway definition load fails (backing store outage). This
    // must not collapse into a definitive unknown_tool.
    getMcpToolDefinitionMock.mockRejectedValue(
      new McpGatewayLoadError({ message: "Failed to load agent skills" }),
    );

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "skill__research" },
      }),
    );
    const body = await readTestJson<McpJsonResponse<CallToolResult>>(response);

    expect(response.status).toBe(200);
    expect(handleMcpToolCallMock).not.toHaveBeenCalled();
    const item = body.result.content.at(0);
    const parsed = item?.type === "text" ? JSON.parse(item.text) : undefined;
    expect(parsed.error.code).toBe("internal_error");
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.error.code).not.toBe("unknown_tool");
    expect(body.result.isError).toBe(true);
    // The load site already captured the DB failure; the transport must not
    // re-capture the mapped gateway error.
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("passes granted scopes to tool listing", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    listMcpToolsMock.mockResolvedValue([
      {
        description: "List matters",
        inputSchema: { type: "object", properties: {} },
        name: "list_matters",
      },
    ]);

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/list",
      }),
    );
    const body =
      await readTestJson<McpJsonResponse<{ tools: McpTool[] }>>(response);

    expect(response.status).toBe(200);
    expect(listMcpToolsMock).toHaveBeenCalledWith(context, "default", [
      "stella:read",
    ]);
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "list_matters",
    ]);
    // Every transport response carries the same release contract as public
    // discovery, so an authenticated CLI can warn about incompatibility too.
    expect(response.headers.get("x-stella-api-contract-version")).toBe(
      String(STELLA_MCP_API_CONTRACT_VERSION),
    );
    expect(response.headers.get("x-stella-cli-minimum")).toBe(
      STELLA_CLI_MINIMUM_VERSION,
    );
    expect(response.headers.get("x-stella-cli-latest")).toBeNull();
    expect(response.headers.get("x-stella-scope-omitted-tools")).toBe(
      "save_filled_template",
    );
    // Tests run as a dev deployment, where every feature-gated tool is served.
    expect(response.headers.get("x-stella-feature-omitted-tools")).toBe("");
  });

  test("rejects tool calls missing the required scope before dynamic resolution", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    getMcpToolRequiredScopesHintMock.mockReturnValue(["stella:skills"]);

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {},
          name: "skill__research",
        },
      }),
    );
    const body = await readTestJson<McpJsonResponse<CallToolResult>>(response);

    expect(response.status).toBe(200);
    expect(getMcpToolRequiredScopesHintMock).toHaveBeenCalledWith(
      "skill__research",
      "default",
    );
    expect(getMcpToolDefinitionMock).not.toHaveBeenCalled();
    expect(handleMcpToolCallMock).not.toHaveBeenCalled();
    expect(body.result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "missing_scope",
              message:
                "Insufficient permissions. Required scope: stella:skills",
              hint: "Grant the 'stella:skills' scope by re-running OAuth consent (CLI: 'stella auth login --scopes stella:read,stella:skills'), then retry.",
            },
          }),
        },
      ],
      isError: true,
    });
  });

  test("rejects tool calls missing an additional compound scope", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:documents_write"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    getMcpToolRequiredScopesHintMock.mockReturnValue([
      "stella:documents_write",
      "stella:templates",
    ]);
    getMcpToolDefinitionMock.mockResolvedValue({
      access: "write",
      additionalScopes: ["stella:templates"],
      anonymized: { exposure: "excluded", reason: "write" },
      description: "Fill and persist a template",
      inputSchema: { type: "object", properties: {} },
      name: "save_filled_template",
      scope: "stella:documents_write",
    });

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {},
          name: "save_filled_template",
        },
      }),
    );
    const body = await readTestJson<McpJsonResponse<CallToolResult>>(response);
    const item = body.result.content.at(0);
    const parsed = item?.type === "text" ? JSON.parse(item.text) : undefined;

    expect(response.status).toBe(200);
    // The tool remains visible when its primary scope is present, so the
    // server must not claim that it was omitted from tools/list.
    expect(response.headers.get("x-stella-scope-omitted-tools")).toBe("");
    expect(parsed?.error).toEqual(
      expect.objectContaining({
        code: "missing_scope",
        hint: "Grant the 'stella:templates' scope by re-running OAuth consent (CLI: 'stella auth login --scopes stella:documents_write,stella:templates'), then retry.",
        message: "Insufficient permissions. Required scope: stella:templates",
      }),
    );
    expect(handleMcpToolCallMock).not.toHaveBeenCalled();
  });

  test("early scope rejection requests the complete compound scope set", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    getMcpToolRequiredScopesHintMock.mockReturnValue([
      "stella:documents_write",
      "stella:templates",
    ]);

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {},
          name: "save_filled_template",
        },
      }),
    );
    const body = await readTestJson<McpJsonResponse<CallToolResult>>(response);
    const item = body.result.content.at(0);
    const parsed = item?.type === "text" ? JSON.parse(item.text) : undefined;

    expect(response.status).toBe(200);
    expect(parsed?.error).toEqual(
      expect.objectContaining({
        code: "missing_scope",
        hint: "Grant the 'stella:documents_write' scope by re-running OAuth consent (CLI: 'stella auth login --scopes stella:read,stella:documents_write,stella:templates'), then retry.",
        message:
          "Insufficient permissions. Required scope: stella:documents_write",
      }),
    );
    expect(getMcpToolDefinitionMock).not.toHaveBeenCalled();
    expect(handleMcpToolCallMock).not.toHaveBeenCalled();
  });

  test("returns an unknown_tool envelope with closest-name hints", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    // No scope hint and no resolved definition: the tool name is unknown. The
    // closest visible name (scope-filtered list) is suggested.
    getMcpToolRequiredScopesHintMock.mockReturnValue(undefined);
    getMcpToolDefinitionMock.mockResolvedValue(undefined);
    listMcpToolsMock.mockResolvedValue([
      {
        description: "List matters",
        inputSchema: { type: "object", properties: {} },
        name: "list_matters",
      },
    ]);

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "list_matter" },
      }),
    );
    const body = await readTestJson<McpJsonResponse<CallToolResult>>(response);

    expect(handleMcpToolCallMock).not.toHaveBeenCalled();
    const item = body.result.content.at(0);
    expect(item?.type).toBe("text");
    const parsed =
      item?.type === "text"
        ? parseUnknownToolErrorEnvelope(item.text)
        : undefined;
    expect(parsed?.error.code).toBe("unknown_tool");
    expect(parsed?.error.hint).toContain("list_matters");
    expect(body.result.isError).toBe(true);
  });

  test("does not fuzzy match unusually long unknown tool names", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    getMcpToolRequiredScopesHintMock.mockReturnValue(undefined);
    getMcpToolDefinitionMock.mockResolvedValue(undefined);
    listMcpToolsMock.mockResolvedValue([
      {
        description: "List matters",
        inputSchema: { type: "object", properties: {} },
        name: "list_matters",
      },
    ]);

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "x".repeat(5000) },
      }),
    );
    const body = await readTestJson<McpJsonResponse<CallToolResult>>(response);

    expect(handleMcpToolCallMock).not.toHaveBeenCalled();
    expect(listMcpToolsMock).not.toHaveBeenCalled();
    const item = body.result.content.at(0);
    expect(item?.type).toBe("text");
    const parsed =
      item?.type === "text"
        ? parseUnknownToolErrorEnvelope(item.text)
        : undefined;
    expect(parsed?.error.code).toBe("unknown_tool");
    expect(parsed?.error.hint).not.toContain("list_matters");
    expect(body.result.isError).toBe(true);
  });

  test("lists static resources for the request mode", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    listMcpResourcesMock.mockReturnValue([
      {
        uri: "stella://reference/template-markers",
        name: "template-markers",
        description: "Template marker grammar",
        mimeType: "text/markdown",
      },
    ]);

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "resources/list",
      }),
    );
    const body =
      await readTestJson<McpJsonResponse<{ resources: Resource[] }>>(response);

    expect(response.status).toBe(200);
    expect(listMcpResourcesMock).toHaveBeenCalledWith("default");
    expect(body.result.resources.map((resource) => resource.uri)).toEqual([
      "stella://reference/template-markers",
    ]);
  });

  test("reads a resource by uri for the request mode", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    readMcpResourceMock.mockReturnValue({
      contents: [
        {
          uri: "stella://reference/template-markers",
          mimeType: "text/markdown",
          text: "marker grammar body",
        },
      ],
    });

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "resources/read",
        params: { uri: "stella://reference/template-markers" },
      }),
    );
    const body =
      await readTestJson<McpJsonResponse<ReadResourceResult>>(response);

    expect(response.status).toBe(200);
    expect(readMcpResourceMock).toHaveBeenCalledWith(
      "stella://reference/template-markers",
      "default",
    );
    expect(body.result.contents).toEqual([
      {
        uri: "stella://reference/template-markers",
        mimeType: "text/markdown",
        text: "marker grammar body",
      },
    ]);
  });
});

describe("MCP transport conformance", () => {
  beforeEach(() => {
    authenticateMcpRequestMock.mockReset();
    captureErrorMock.mockReset();
    listMcpToolsMock.mockReset();
    listMcpToolsMock.mockImplementation(async () => []);
    resolveMcpSessionContextMock.mockReset();
  });

  const authenticateSession = () => {
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue({ type: "mcp-context" });
  };

  const TOOLS_LIST_BODY = JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/list",
  });

  const toolsListRequest = (accept?: string) =>
    new Request("http://localhost/mcp", {
      body: TOOLS_LIST_BODY,
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        ...(accept === undefined ? {} : { accept }),
      },
      method: "POST",
    });

  /** A streamed body arrives without `content-length`, exactly as chunked. */
  const chunkedMcpRequest = (body: string) =>
    new Request("http://localhost/mcp", {
      body: new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      duplex: "half",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      method: "POST",
    });

  test("answers an unauthenticated probe with a JSON-RPC envelope, not a bare string", async () => {
    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", { method: "POST" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await readTestJson<McpJsonRpcError>(response)).toEqual({
      error: { code: -32_001, message: "Missing Authorization header" },
      id: null,
      jsonrpc: "2.0",
    });
    // RFC 6750 §3.1: nothing was presented, so nothing was rejected.
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).not.toContain("error=");
  });

  test("names the RFC 6750 error code once a presented token is rejected", async () => {
    authenticateMcpRequestMock.mockRejectedValue(
      new McpAuthenticationError({ message: "Token expired" }),
    );

    const response = await handleMcpHttpRequest(toolsListRequest());
    const challenge = response.headers.get("WWW-Authenticate") ?? "";

    expect(response.status).toBe(401);
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain("error_description=");
    expect(challenge).toContain("resource_metadata=");
  });

  test("serves a POST whose Accept covers both media types through a wildcard", async () => {
    authenticateSession();

    const responses = await Promise.all(
      ["*/*", "application/*, text/*", "*/*;q=0.8", undefined].map(
        async (accept) => await handleMcpHttpRequest(toolsListRequest(accept)),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
  });

  test("keeps 406 for an Accept that genuinely excludes the event stream", async () => {
    authenticateSession();

    const responses = await Promise.all(
      [
        "application/json",
        "application/json, */*;q=0",
        // The specific refusal outranks the wildcard that would cover it.
        "application/json;q=0, */*",
      ].map(
        async (accept) => await handleMcpHttpRequest(toolsListRequest(accept)),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([
      406, 406, 406,
    ]);
  });

  test("reads no body before the token is accepted", async () => {
    authenticateMcpRequestMock.mockRejectedValue(
      new McpAuthenticationError({ message: "Token expired" }),
    );
    let pulls = 0;
    // `start` fills the queue, so any pull is the handler reading the body.
    const unreadBody = () =>
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        pull: (controller) => {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("x"));
        },
      });
    const chunkedRequest = (authorization?: string) =>
      new Request("http://localhost/mcp", {
        body: unreadBody(),
        duplex: "half",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        method: "POST",
      });

    const responses = await Promise.all(
      [undefined, "Bearer expired"].map(
        async (authorization) =>
          await handleMcpHttpRequest(chunkedRequest(authorization)),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([401, 401]);
    expect(pulls).toBe(0);
  });

  test("advertises only the methods the transport serves on preflight", async () => {
    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", { method: "OPTIONS" }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Allow")).toBe(MCP_STATELESS_ALLOW_HEADER);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      MCP_STATELESS_ALLOW_HEADER,
    );
    // `Allow-Origin: *` together with credentials is refused by every browser,
    // and this endpoint reads bearer tokens, never cookies.
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("refuses an oversized declared body before authenticating or parsing", async () => {
    authenticateSession();

    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", {
        body: "x".repeat(MCP_MAX_REQUEST_BODY_BYTES + 1),
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer token",
          // A constructed Request declares no length on its own.
          "content-length": String(MCP_MAX_REQUEST_BODY_BYTES + 1),
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    const body = await readTestJson<McpJsonRpcError>(response);

    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.error.code).toBe(-32_000);
    expect(authenticateMcpRequestMock).not.toHaveBeenCalled();
  });

  test("meters a chunked body that declares no length, once the token is accepted", async () => {
    authenticateSession();

    const response = await handleMcpHttpRequest(
      chunkedMcpRequest("x".repeat(MCP_MAX_REQUEST_BODY_BYTES + 1)),
    );

    expect(response.status).toBe(413);
    expect(authenticateMcpRequestMock).toHaveBeenCalledTimes(1);
  });

  test("hands a chunked body within the cap to the transport intact", async () => {
    authenticateSession();
    listMcpToolsMock.mockResolvedValue([
      {
        description: "List matters",
        inputSchema: { properties: {}, type: "object" },
        name: "list_matters",
      },
    ]);

    const response = await handleMcpHttpRequest(
      chunkedMcpRequest(TOOLS_LIST_BODY),
    );
    const body =
      await readTestJson<McpJsonResponse<{ tools: McpTool[] }>>(response);

    expect(response.status).toBe(200);
    expect(body.result.tools.at(0)?.name).toBe("list_matters");
  });
});

// The reason split is exercised through its injected feature gate: mocking
// `env` for the whole module graph would bleed across files in this process.
describe("mcpOmittedToolNamesByReason", () => {
  test("attests feature-gated tools while their deployment flag is off", () => {
    const omitted = mcpOmittedToolNamesByReason({
      grantedScopes: MCP_ALL_RESOURCE_SCOPES,
      isFeatureEnabled: (feature) => feature !== "FEATURE_PUBLIC_LAW",
      mode: "default",
    });
    const gated = listStaticMcpToolDefinitions("default")
      .filter((definition) => definition.feature === "FEATURE_PUBLIC_LAW")
      .map((definition) => definition.name);

    expect(gated.length).toBeGreaterThan(0);
    expect(omitted.feature).toEqual([...gated].sort());
    // A fully granted token omits nothing for scope, so the feature evidence is
    // the complete explanation for what the projection dropped.
    expect(omitted.scope).toEqual([]);
  });

  test("attests each omitted tool under exactly one reason", () => {
    const omitted = mcpOmittedToolNamesByReason({
      grantedScopes: ["stella:read"],
      isFeatureEnabled: (feature) => feature !== "FEATURE_TIME_BILLING",
      mode: "default",
    });

    expect(omitted.feature.length).toBeGreaterThan(0);
    expect(omitted.scope).toContain("save_filled_template");
    // A tool gated off in this deployment is absent for every caller, so the
    // feature reason wins and no name is attested twice.
    expect(
      omitted.feature.filter((name) => omitted.scope.includes(name)),
    ).toEqual([]);
  });

  test("a fully served deployment with all grants attests no omission", () => {
    expect(
      mcpOmittedToolNamesByReason({
        grantedScopes: MCP_ALL_RESOURCE_SCOPES,
        isFeatureEnabled: () => true,
        mode: "default",
      }),
    ).toEqual({ feature: [], scope: [] });
  });
});
