import type {
  CallToolResult,
  Tool as McpTool,
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  STELLA_CLI_LATEST_VERSION,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";
import {
  McpAuthenticationError,
  McpOrganizationAccessError,
} from "@/api/mcp/errors";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import type { ToolScope } from "@/api/mcp/tool-types";
import { readTestJson } from "@/api/tests/helpers/test-tool-set";

const authenticateMcpRequestMock = mock();
const captureErrorMock = mock();
const resolveMcpSessionContextMock = mock();
const getMcpToolDefinitionMock = mock();
const getMcpToolScopeHintMock = mock(
  (_toolName: string): ToolScope | undefined => undefined,
);
const handleMcpToolCallMock = mock();
const listMcpToolsMock = mock(async (): Promise<McpTool[]> => []);
const listMcpResourcesMock = mock((): Resource[] => []);
const readMcpResourceMock = mock((): ReadResourceResult => ({ contents: [] }));

const handleMcpHttpRequest = createMcpHttpRequestHandler({
  authenticateMcpRequest: authenticateMcpRequestMock,
  captureError: (error, context) => {
    captureErrorMock(error, context);
  },
  getMcpToolDefinition: getMcpToolDefinitionMock,
  getMcpToolScopeHint: getMcpToolScopeHintMock,
  handleMcpToolCall: handleMcpToolCallMock,
  listMcpResources: listMcpResourcesMock,
  listMcpTools: listMcpToolsMock,
  readMcpResource: readMcpResourceMock,
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

describe("handleMcpHttpRequest", () => {
  beforeEach(() => {
    authenticateMcpRequestMock.mockReset();
    captureErrorMock.mockReset();
    getMcpToolDefinitionMock.mockReset();
    getMcpToolScopeHintMock.mockReset();
    getMcpToolScopeHintMock.mockImplementation(
      (_toolName: string): ToolScope | undefined => undefined,
    );
    handleMcpToolCallMock.mockReset();
    listMcpToolsMock.mockReset();
    listMcpToolsMock.mockImplementation(async () => []);
    listMcpResourcesMock.mockReset();
    listMcpResourcesMock.mockImplementation(() => []);
    readMcpResourceMock.mockReset();
    readMcpResourceMock.mockImplementation(() => ({ contents: [] }));
    resolveMcpSessionContextMock.mockReset();
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
    expect(await response.text()).toBe("Invalid or expired token");
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
    expect(await response.text()).toBe("Forbidden");
    expect(resolveMcpSessionContextMock).toHaveBeenCalledWith(
      {
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      },
      { request: mcpRequest },
    );
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("captures unexpected transport errors while returning a generic 401", async () => {
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

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid or expired token");
    expect(captureErrorMock).toHaveBeenCalledWith(error, {
      mode: "default",
      phase: "transport",
      source: "mcp",
    });
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
    expect(response.headers.get("x-stella-cli-latest")).toBe(
      STELLA_CLI_LATEST_VERSION,
    );
  });

  test("rejects tool calls missing the required scope before dynamic resolution", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue({
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });
    resolveMcpSessionContextMock.mockResolvedValue(context);
    getMcpToolScopeHintMock.mockReturnValue("stella:skills");

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
    expect(getMcpToolScopeHintMock).toHaveBeenCalledWith(
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
              hint: "Grant the 'stella:skills' scope by re-running OAuth consent (CLI: 'stella auth login --scopes stella:skills'), then retry.",
            },
          }),
        },
      ],
      isError: true,
    });
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
    getMcpToolScopeHintMock.mockReturnValue(undefined);
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
    getMcpToolScopeHintMock.mockReturnValue(undefined);
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
