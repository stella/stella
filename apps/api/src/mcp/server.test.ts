import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  McpAuthenticationError,
  McpOrganizationAccessError,
} from "@/api/mcp/errors";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";

const authenticateMcpRequestMock = mock();
const captureErrorMock = mock();
const resolveMcpSessionContextMock = mock();
const getMcpToolDefinitionMock = mock();
const handleMcpToolCallMock = mock();
const listMcpToolsMock = mock(() => []);

const handleMcpHttpRequest = createMcpHttpRequestHandler({
  authenticateMcpRequest: authenticateMcpRequestMock,
  captureError: (error, context) => {
    captureErrorMock(error, context);
  },
  getMcpToolDefinition: getMcpToolDefinitionMock,
  handleMcpToolCall: handleMcpToolCallMock,
  listMcpTools: listMcpToolsMock,
  resolveMcpSessionContext: resolveMcpSessionContextMock,
});

describe("handleMcpHttpRequest", () => {
  beforeEach(() => {
    authenticateMcpRequestMock.mockReset();
    captureErrorMock.mockReset();
    getMcpToolDefinitionMock.mockReset();
    handleMcpToolCallMock.mockReset();
    listMcpToolsMock.mockReset();
    listMcpToolsMock.mockImplementation(() => []);
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

    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", {
        headers: {
          authorization: "Bearer token",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
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
});
