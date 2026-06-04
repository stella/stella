import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";

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

const handleMcpHttpRequest = createMcpHttpRequestHandler({
  authenticateMcpRequest: authenticateMcpRequestMock,
  captureError: (error, context) => {
    captureErrorMock(error, context);
  },
  getMcpToolDefinition: getMcpToolDefinitionMock,
  getMcpToolScopeHint: getMcpToolScopeHintMock,
  handleMcpToolCall: handleMcpToolCallMock,
  listMcpTools: listMcpToolsMock,
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
          text: "Insufficient permissions. Required scope: stella:skills",
          type: "text",
        },
      ],
      isError: true,
    });
  });
});
