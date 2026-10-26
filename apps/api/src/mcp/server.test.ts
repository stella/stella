import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  Tool as McpTool,
} from "@modelcontextprotocol/server";
import { panic, Result } from "better-result";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";
import { ACTION_ADMISSION_REFUSALS } from "@stll/api-contract/action-admission";

import { env } from "@/api/env";
import {
  resetAnalyticsForTesting,
  setAnalyticsForTesting,
} from "@/api/lib/analytics/client";
import type { ServerAnalyticsCaptureParams } from "@/api/lib/analytics/server-analytics";
import { checkDemoAccountAccess } from "@/api/lib/auth/demo-account-policy";
import type { ResolveCredentialMemberAuthorization } from "@/api/lib/auth/member-authorization";
import { toSafeId } from "@/api/lib/branded-types";
import { runWithRequestId } from "@/api/lib/observability/request-context";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import {
  ActionAdmissionError,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import type { getActionSizePolicy } from "@/api/lib/rate-limit/action-size-limits";
import { DEMO_ACCOUNT_DAILY_ACTION_BUDGET } from "@/api/lib/rate-limit/demo-action-budget";
import { sweepBoundStreams } from "@/api/lib/sse";
import {
  resolveMachineApiKeySession,
  revalidateMachineApiKeySession,
} from "@/api/mcp/api-key-auth";
import { recordMcpSessionInitialized } from "@/api/mcp/client-identity";
import {
  MCP_ALL_RESOURCE_SCOPES,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_STATELESS_ALLOW_HEADER,
  STELLA_CLI_LATEST_VERSION,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import {
  type McpAccessRefusalError,
  McpAuthenticationError,
  McpGatewayLoadError,
  McpOrganizationAccessError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { MCP_INSTRUCTIONS } from "@/api/mcp/instructions";
import { LEGAL_RESOLVE_TOOL_SET } from "@/api/mcp/legal-resolve-tools";
import { getMcpWwwAuthenticateHeader } from "@/api/mcp/metadata";
import {
  createMcpHttpRequestHandler,
  mcpOmittedToolNamesByReason,
} from "@/api/mcp/server-core";
import {
  DOCUMENTS_MCP_TOOL_DEFINITIONS,
  LAW_MCP_TOOL_DEFINITIONS,
  listStaticMcpToolDefinitions,
} from "@/api/mcp/static-tool-definitions";
import type { ToolScope } from "@/api/mcp/tool-types";
import { createTestDemoActionBudget } from "@/api/tests/helpers/demo-action-budget";
import { readTestJson } from "@/api/tests/helpers/test-tool-set";
import { compileClientWireSchema } from "@/api/tests/helpers/wire-json-schema";

const actionSizePolicyMock = mock((): ReturnType<typeof getActionSizePolicy> =>
  Result.ok(undefined),
);
const authenticateMcpRequestMock = mock();
const captureErrorMock = mock();
const observeTransportFailureMock = mock();
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

const mcpHandlerDependencies = {
  actionSizePolicy: actionSizePolicyMock,
  authenticateMcpRequest: authenticateMcpRequestMock,
  captureError: (error, { context }) => {
    captureErrorMock(error, context);
  },
  observeTransportFailure: (error, context) => {
    observeTransportFailureMock(error, context);
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
} satisfies Parameters<typeof createMcpHttpRequestHandler>[0];

const handleMcpHttpRequest = createMcpHttpRequestHandler(
  mcpHandlerDependencies,
);

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
  id: number | string;
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
      ...(typeof params["name"] === "string"
        ? { "mcp-name": params["name"] }
        : {}),
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

/** An error that answers a request whose id was read. */
type McpJsonRpcFailure = {
  error: { code: number; message: string };
  id: number | string | null;
  jsonrpc: "2.0";
};

describe("handleMcpHttpRequest", () => {
  beforeEach(() => {
    actionSizePolicyMock.mockReset();
    actionSizePolicyMock.mockImplementation(() => Result.ok(undefined));
    authenticateMcpRequestMock.mockReset();
    captureErrorMock.mockReset();
    observeTransportFailureMock.mockReset();
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
    resetMetricLineSinkForTesting();
  });

  test("a real MCP transport request emits exactly one phase record", async () => {
    const toolProjectionDelayMs = 100;
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    authenticateMcpRequestMock.mockImplementation(async () => {
      await Bun.sleep(5);
      return Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      });
    });
    resolveMcpSessionContextMock.mockResolvedValue({
      organizationId: "org_1",
      userId: "user_1",
    });
    listMcpToolsMock.mockImplementation(async () => {
      await Bun.sleep(toolProjectionDelayMs);
      return [];
    });

    const response = await handleMcpHttpRequest(
      createModernMcpRequest({ id: 1, method: "tools/list" }),
    );

    expect(response.status).toBe(200);
    const records = lines
      .map((line) => JSON.parse(line))
      .filter((record) => record.event === "mcp.request.phases");
    expect(records).toHaveLength(1);
    const record = records.at(0);
    expect(record).toMatchObject({
      event: "mcp.request.phases",
      method: "tools/list",
      mode: "default",
      overlap: false,
      path: "modern",
    });
    const phaseTotal = [
      record.auth,
      record.context,
      record.server_build,
      record.tool_projection,
      record.dispatch,
    ].reduce((total, duration) => total + duration, 0);
    expect(record.auth).toBeGreaterThan(0);
    expect(record.tool_projection).toBeGreaterThanOrEqual(
      toolProjectionDelayMs,
    );
    expect(record.tool_projection).toBeGreaterThan(0);
    expect(record.server_build).toBeLessThan(record.tool_projection);
    expect(phaseTotal).toBeLessThanOrEqual(record.total);
  });

  test("modern method metrics preserve the parsed method when a method header is present", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
    resolveMcpSessionContextMock.mockResolvedValue({
      organizationId: "org_1",
      userId: "user_1",
    });

    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });

    const response = await handleMcpHttpRequest(
      createModernMcpRequest({ id: 1, method: "tools/list" }),
    );

    expect(response.status).toBe(200);
    expect(
      lines
        .map((line) => JSON.parse(line))
        .find((record) => record.event === "mcp.request.phases"),
    ).toMatchObject({ method: "tools/list", path: "modern" });
  });

  test.each([
    ["list_matters", "list_matters"],
    ["mcp__tenant_connector__lookup", "external_mcp"],
    ["skill__tenant_research", "skill"],
  ])(
    "phase metrics classify the resolved %s tool as %s",
    async (toolName, metricToolName) => {
      const staticDefinition = listStaticMcpToolDefinitions("default").find(
        ({ name }) => name === "list_matters",
      );
      if (staticDefinition === undefined) {
        panic("Canonical list_matters tool definition is missing");
      }
      authenticateMcpRequestMock.mockResolvedValue(
        Result.ok({
          organizationId: "org_1",
          scopes: ["stella:read", "stella:skills"],
          userId: "user_1",
        }),
      );
      resolveMcpSessionContextMock.mockResolvedValue({ type: "mcp-context" });
      getMcpToolDefinitionMock.mockResolvedValue({
        ...staticDefinition,
        name: toolName,
      });
      handleMcpToolCallMock.mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const lines: string[] = [];
      setMetricLineSinkForTesting((line) => {
        lines.push(line);
      });

      const response = await handleMcpHttpRequest(
        createModernMcpRequest({
          id: 1,
          method: "tools/call",
          params: { arguments: {}, name: toolName },
        }),
      );

      expect(response.status).toBe(200);
      const phaseRecord = lines
        .map((line) => JSON.parse(line))
        .find((record) => record.event === "mcp.request.phases");
      expect(phaseRecord).toMatchObject({
        method: "tools/call",
        toolName: metricToolName,
      });
      if (toolName !== metricToolName) {
        expect(JSON.stringify(phaseRecord)).not.toContain(toolName);
      }
    },
  );

  test("method metrics do not clone or reparse a large request body", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
    resolveMcpSessionContextMock.mockResolvedValue({
      organizationId: "org_1",
      userId: "user_1",
    });
    const request = createModernMcpRequest({
      id: 1,
      method: "tools/list",
      params: { padding: "x".repeat(100_000) },
    });
    const clone = mock(() => {
      throw new Error("request body was cloned");
    });
    Object.defineProperty(request, "clone", { value: clone });

    const response = await handleMcpHttpRequest(request);

    expect(response.status).toBe(200);
    expect(clone).not.toHaveBeenCalled();
  });

  test("native admission refusals keep their code and capture only infrastructure failure", async () => {
    const previousEnabled = env.FEATURE_ACTION_ADMISSION;
    const previousContact = env.ACTION_LIMIT_CONTACT_URL;
    env.FEATURE_ACTION_ADMISSION = true;
    env.ACTION_LIMIT_CONTACT_URL = "https://example.invalid/contact";
    try {
      for (const reason of [
        "busy",
        "period_exhausted",
        "not_enabled",
        "unavailable",
      ] as const) {
        captureErrorMock.mockClear();
        const refusalError = new ActionAdmissionError({
          reason,
          message: "Private internal detail",
        });
        authenticateMcpRequestMock.mockResolvedValue(
          Result.ok({
            organizationId: "org_1",
            scopes: ["stella:read"],
            userId: "user_1",
          }),
        );
        resolveMcpSessionContextMock.mockResolvedValue({
          organizationId: "org_1",
          userId: "user_1",
        });
        getMcpToolDefinitionMock.mockResolvedValue({
          name: "get_document",
          scope: "stella:read",
          access: "read",
          permissions: { type: "open-read", reason: "reads only fixture data" },
          description: "Read a document",
          inputSchema: { type: "object", properties: {} },
        });
        const handler = createMcpHttpRequestHandler({
          ...mcpHandlerDependencies,
          admitAction: async () => Result.err(refusalError),
        });
        const response = await runWithRequestId(
          "req_admission",
          async () =>
            await handler(
              createMcpRequest({
                id: 1,
                jsonrpc: "2.0",
                method: "tools/call",
                params: { name: "get_document", arguments: {} },
              }),
            ),
        );
        const body =
          await readTestJson<McpJsonResponse<CallToolResult>>(response);
        const item = body.result.content.at(0);
        const payload =
          item?.type === "text" ? JSON.parse(item.text) : undefined;
        const refusal = ACTION_ADMISSION_REFUSALS[refusalError.code];
        const contact =
          reason === "period_exhausted" || reason === "not_enabled";
        expect(body.result.isError).toBe(true);
        expect(payload?.error).toEqual({
          code: refusalError.code,
          message: refusal.message,
          retryable: refusal.retryable,
          ...(contact ? { contactUrl: "https://example.invalid/contact" } : {}),
          hint: contact
            ? `${refusal.hint} Contact: https://example.invalid/contact`
            : refusal.hint,
          requestId: "req_admission",
        });
        expect(captureErrorMock.mock.calls.length).toBe(
          reason === "unavailable" ? 1 : 0,
        );
        expect(handleMcpToolCallMock).not.toHaveBeenCalled();
      }
    } finally {
      env.FEATURE_ACTION_ADMISSION = previousEnabled;
      env.ACTION_LIMIT_CONTACT_URL = previousContact;
    }
  });

  test("flags off still count the demo account's tool calls", async () => {
    const previous = {
      FEATURE_ACTION_ADMISSION: env.FEATURE_ACTION_ADMISSION,
      FEATURE_ACTION_COST_RECORDS: env.FEATURE_ACTION_COST_RECORDS,
    };
    Object.assign(env, {
      FEATURE_ACTION_ADMISSION: false,
      FEATURE_ACTION_COST_RECORDS: false,
    });
    try {
      const demo = createTestDemoActionBudget({
        demoUserId: toSafeId<"user">("user_1"),
        nowMs: Date.UTC(2026, 0, 15),
      });
      authenticateMcpRequestMock.mockResolvedValue(
        Result.ok({
          organizationId: "org_1",
          scopes: ["stella:read"],
          userId: "user_1",
        }),
      );
      resolveMcpSessionContextMock.mockResolvedValue({
        organizationId: "org_1",
        userId: "user_1",
      });
      getMcpToolDefinitionMock.mockResolvedValue({
        name: "get_document",
        scope: "stella:read",
        access: "read",
        permissions: { type: "open-read", reason: "reads only fixture data" },
        description: "Read a document",
        inputSchema: { type: "object", properties: {} },
      });
      handleMcpToolCallMock.mockResolvedValue({
        content: [{ type: "text", text: "served" }],
      });
      const handler = createMcpHttpRequestHandler({
        ...mcpHandlerDependencies,
        admitAction: async (options) =>
          await withActionAdmission({
            ...options,
            demoActionBudget: demo.budget,
          }),
      });
      const callTool = async () =>
        await readTestJson<McpJsonResponse<CallToolResult>>(
          await handler(
            createMcpRequest({
              id: 1,
              jsonrpc: "2.0",
              method: "tools/call",
              params: { name: "get_document", arguments: {} },
            }),
          ),
        );

      expect((await callTool()).result.isError).toBeFalsy();
      expect(demo.count()).toBe(1);
      expect(handleMcpToolCallMock).toHaveBeenCalledTimes(1);

      for (
        let index = 1;
        index < DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max;
        index++
      ) {
        await withActionAdmission({
          organizationId: toSafeId<"organization">("org_1"),
          userId: toSafeId<"user">("user_1"),
          demoActionBudget: demo.budget,
          run: async () => await Promise.resolve(undefined),
        });
      }
      const refused = await callTool();
      const item = refused.result.content.at(0);
      const payload = item?.type === "text" ? JSON.parse(item.text) : undefined;
      expect(refused.result.isError).toBe(true);
      expect(payload?.error).toMatchObject({ code: "action_period_exhausted" });
      expect(handleMcpToolCallMock).toHaveBeenCalledTimes(1);
      expect(demo.count()).toBe(DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max);
    } finally {
      Object.assign(env, previous);
    }
  });

  test("returns a generic 401 for token validation failures", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.err(
        new McpAuthenticationError({
          message: "Token missing org_id claim",
        }),
      ),
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
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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

  test("returns a policy 403 for an authenticated account refusal", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        userId: "user_one",
        organizationId: "org_one",
        scopes: ["stella:read"],
      }),
    );
    resolveMcpSessionContextMock.mockImplementation(
      async (session, options) =>
        await resolveMcpSessionContext(session, {
          ...options,
          resolveAuthorization: async () =>
            ({
              memberId: "member_one",
              email: "limited@example.test",
              role: "owner",
              workspace: null,
              emailVerified: true,
              userDeleted: false,
              enrolledFeatureIds: [],
              professionalUse: { status: "required" },
            }) satisfies NonNullable<
              Awaited<ReturnType<ResolveCredentialMemberAuthorization>>
            >,
          checkAccountOperation: (email) =>
            checkDemoAccountAccess({
              email,
              config: {
                email: "limited@example.test",
                organizationId: "org_one",
              },
              operation: "growth",
            }),
        }),
    );
    const response = await handleMcpHttpRequest(
      createMcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).not.toContain(
      'error="invalid_token"',
    );
    expect(await readTestJson<McpJsonRpcError>(response)).toMatchObject({
      error: { code: -32_001, message: "Forbidden" },
    });
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("refuses the demo account every MCP request, read-only discovery and read calls included", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        userId: "user_one",
        organizationId: "org_one",
        scopes: ["stella:read"],
      }),
    );
    resolveMcpSessionContextMock.mockImplementation(
      async (session, options) =>
        await resolveMcpSessionContext(session, {
          ...options,
          resolveAuthorization: async () =>
            ({
              memberId: "member_one",
              email: "limited@example.test",
              role: "owner",
              workspace: null,
              emailVerified: true,
              userDeleted: false,
              enrolledFeatureIds: [],
              professionalUse: { status: "required" },
            }) satisfies NonNullable<
              Awaited<ReturnType<ResolveCredentialMemberAuthorization>>
            >,
          checkAccountOperation: (email) =>
            checkDemoAccountAccess({
              email,
              config: {
                email: "limited@example.test",
                organizationId: "org_one",
              },
              operation: "growth",
            }),
        }),
    );
    // A read-only tool: the refusal is session-wide, not per write tool.
    const readTool = listStaticMcpToolDefinitions("default").find(
      (definition) => definition.access === "read",
    );
    if (readTool === undefined) {
      throw new Error("The default surface must serve a read tool");
    }
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: readTool.name, arguments: {} },
      },
    ];
    for (const body of requests) {
      const response = await handleMcpHttpRequest(createMcpRequest(body));
      expect({ method: body.method, status: response.status }).toEqual({
        method: body.method,
        status: 403,
      });
      expect(await readTestJson<McpJsonRpcFailure>(response)).toEqual({
        error: { code: -32_001, message: "Forbidden" },
        id: body.id,
        jsonrpc: "2.0",
      });
    }
    expect(listMcpToolsMock).not.toHaveBeenCalled();
    expect(handleMcpToolCallMock).not.toHaveBeenCalled();
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("answers every organization access refusal with the same 403 on both transports", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        userId: "user_one",
        organizationId: "org_one",
        scopes: ["stella:read"],
      }),
    );
    const refusals = {
      membership: async () => {
        throw new McpOrganizationAccessError({
          message: "User is not a member of this organization",
        });
      },
      demo_account: async (
        session: Parameters<typeof resolveMcpSessionContext>[0],
        options: Parameters<typeof resolveMcpSessionContext>[1],
      ) =>
        await resolveMcpSessionContext(session, {
          ...options,
          resolveAuthorization: async () =>
            ({
              memberId: "member_one",
              email: "limited@example.test",
              role: "owner",
              workspace: null,
              emailVerified: true,
              userDeleted: false,
              enrolledFeatureIds: [],
              professionalUse: { status: "required" },
            }) satisfies NonNullable<
              Awaited<ReturnType<ResolveCredentialMemberAuthorization>>
            >,
          checkAccountOperation: (email) =>
            checkDemoAccountAccess({
              email,
              config: {
                email: "limited@example.test",
                organizationId: "org_one",
              },
              operation: "growth",
            }),
        }),
    };

    for (const [refusal, resolveContext] of Object.entries(refusals)) {
      for (const protocol of ["legacy", "modern"] as const) {
        captureErrorMock.mockClear();
        observeTransportFailureMock.mockClear();
        resolveMcpSessionContextMock.mockImplementation(resolveContext);
        const response = await handleMcpHttpRequest(
          protocol === "modern"
            ? createModernMcpRequest({ id: 7, method: "tools/list" })
            : createMcpRequest({
                id: 7,
                jsonrpc: "2.0",
                method: "tools/list",
                params: {},
              }),
        );

        expect({
          refusal,
          protocol,
          status: response.status,
          retryAfter: response.headers.get("Retry-After"),
          captured: captureErrorMock.mock.calls.length,
          observed: observeTransportFailureMock.mock.calls.length,
        }).toEqual({
          refusal,
          protocol,
          status: 403,
          retryAfter: null,
          captured: 0,
          observed: 0,
        });
        expect(response.headers.get("WWW-Authenticate")).not.toContain(
          "error=",
        );
        expect(await readTestJson<McpJsonRpcFailure>(response)).toEqual({
          error: { code: -32_001, message: "Forbidden" },
          id: 7,
          jsonrpc: "2.0",
        });
      }
    }
    expect(listMcpToolsMock).not.toHaveBeenCalled();
  });

  test("answers every refusal kind raised while resolving the session with its denial on both transports", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
    // Total over the refusal union: a new refusal kind fails to compile here
    // until its expected answer is stated.
    const refusals = {
      McpAuthenticationError: {
        error: () => new McpAuthenticationError({ message: "Token revoked" }),
        status: 401,
        message: "Invalid or expired token",
      },
      McpOrganizationAccessError: {
        error: () =>
          new McpOrganizationAccessError({ message: "Membership removed" }),
        status: 403,
        message: "Forbidden",
      },
    } satisfies Record<
      McpAccessRefusalError["_tag"],
      {
        error: () => McpAccessRefusalError;
        status: 401 | 403;
        message: string;
      }
    >;

    for (const [tag, refusal] of Object.entries(refusals)) {
      for (const protocol of ["legacy", "modern"] as const) {
        captureErrorMock.mockClear();
        observeTransportFailureMock.mockClear();
        resolveMcpSessionContextMock.mockRejectedValue(refusal.error());
        const response = await handleMcpHttpRequest(
          protocol === "modern"
            ? createModernMcpRequest({ id: 3, method: "tools/list" })
            : createMcpRequest({
                id: 3,
                jsonrpc: "2.0",
                method: "tools/list",
                params: {},
              }),
        );

        expect({
          tag,
          protocol,
          status: response.status,
          captured: captureErrorMock.mock.calls.length,
          observed: observeTransportFailureMock.mock.calls.length,
          body: await readTestJson<McpJsonRpcFailure>(response),
        }).toEqual({
          tag,
          protocol,
          status: refusal.status,
          captured: 0,
          observed: 0,
          body: {
            error: { code: -32_001, message: refusal.message },
            id: 3,
            jsonrpc: "2.0",
          },
        });
      }
    }
  });

  test("captures unexpected transport errors as a retryable 5xx, not a 401", async () => {
    const error = new Error("database connection refused");
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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
    expect(observeTransportFailureMock).toHaveBeenCalledWith(error, {
      mode: "default",
      request: expect.any(Request),
    });
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("captures modern handler failures and preserves the retryable transport contract", async () => {
    const error = new Error("database connection refused");
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
    resolveMcpSessionContextMock.mockRejectedValue(error);

    const response = await handleMcpHttpRequest(
      createModernMcpRequest({ id: 1, method: "tools/list" }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await readTestJson<McpJsonRpcFailure>(response)).toEqual({
      error: { code: -32_000, message: "Service temporarily unavailable" },
      id: 1,
      jsonrpc: "2.0",
    });
    expect(observeTransportFailureMock).toHaveBeenCalledWith(error, {
      mode: "default",
      request: expect.any(Request),
    });
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("a server fault answers with the request's JSON-RPC id on both transports", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
    resolveMcpSessionContextMock.mockRejectedValue(
      new Error("database connection refused"),
    );

    for (const [protocol, id] of [
      ["legacy", 7],
      ["legacy", "request-7"],
      ["modern", 7],
      ["modern", "request-7"],
    ] as const) {
      const body = { id, jsonrpc: "2.0", method: "tools/list", params: {} };
      const response = await handleMcpHttpRequest(
        protocol === "modern"
          ? createModernMcpRequest({ id, method: body.method })
          : createMcpRequest(body),
      );

      expect({ protocol, status: response.status }).toEqual({
        protocol,
        status: 503,
      });
      expect(await readTestJson<McpJsonRpcFailure>(response)).toEqual({
        error: { code: -32_000, message: "Service temporarily unavailable" },
        id,
        jsonrpc: "2.0",
      });
    }
  });

  test("builds a fresh modern server for each authenticated session", async () => {
    authenticateMcpRequestMock.mockImplementation((token: string) =>
      Result.ok({
        organizationId: token === "first" ? "org_1" : "org_2",
        scopes: ["stella:read"],
        userId: token === "first" ? "user_1" : "user_2",
      }),
    );
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
    // The transport checks write authority before dispatch, so the session
    // carries a role that holds both upload tools.
    const context = { type: "documents-mcp-context", memberRole: "owner" };
    const definitions = DOCUMENTS_MCP_TOOL_DEFINITIONS.filter(({ name }) =>
      ["upload_document_version", "open_document_version_upload"].includes(
        name,
      ),
    );
    if (definitions.length !== 2) {
      panic("Canonical upload and picker tool definitions are missing");
    }
    const pickerResult = {
      entityId: "00000000-0000-4000-8000-0000000e0001",
      workspaceId: "workspace_1",
      nextStep: "Have the user choose a file in the upload panel.",
    };

    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: [
          "stella:read",
          "stella:documents_write",
          "stella:matters_write",
        ],
        userId: "user_1",
      }),
    );
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
              structuredContent: {
                finalizedResult: {
                  type: "entity_version",
                  entityId: "00000000-0000-4000-8000-0000000e0001",
                  entityVersionId: "version_1",
                  versionNumber: 2,
                  fileId: "file_1",
                  fileName: "agreement.docx",
                },
              },
            }
          : {
              content: [{ type: "text", text: JSON.stringify(pickerResult) }],
              structuredContent: pickerResult,
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
        finalizedResult: {
          type: "entity_version",
          entityId: "00000000-0000-4000-8000-0000000e0001",
          entityVersionId: "version_1",
          versionNumber: 2,
          fileId: "file_1",
          fileName: "agreement.docx",
        },
      });
      const opened = await client.callTool(
        {
          name: "open_document_version_upload",
          arguments: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
        },
        { timeout: 2000 },
      );
      expect(opened.structuredContent).toEqual(pickerResult);
      expect(authenticateMcpRequestMock).toHaveBeenCalledWith("token", {
        mode: "documents",
        resolveApiKeySession: resolveMachineApiKeySession,
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

  test("the law audience serves the corpus tools under its own server name", async () => {
    const context = { type: "law-mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:search", "stella:read"],
        userId: "user_1",
      }),
    );
    resolveMcpSessionContextMock.mockResolvedValue(context);
    listMcpToolsMock.mockResolvedValue(toMcpTools(LAW_MCP_TOOL_DEFINITIONS));

    const transportFetch: FetchLike = async (input, init) =>
      await handleMcpHttpRequest(new Request(input.toString(), init), {
        mode: "law",
      });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp-law"),
      {
        fetch: transportFetch,
        requestInit: { headers: { authorization: "Bearer token" } },
      },
    );
    const client = new Client({ name: "stella-e2e-test", version: "1.0.0" });

    try {
      await client.connect(transport, { timeout: 2000 });

      // A client keys its saved server entry off this name, so each audience
      // is distinguishable without comparing tool lists.
      expect(client.getServerVersion()?.name).toBe("stella (law)");
      expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS.law);

      const listed = await client.listTools(undefined, { timeout: 2000 });
      expect(listed.tools.map(({ name }) => name)).toEqual([
        "search",
        "fetch",
        "search_case_law",
        "case_law_coverage",
        "read_case_law_decision",
        "read_case_law_citations",
        "open_case_law_decision",
        "read_case_law_decision_blocks",
        "preview_cited_provision",
        "search_legislation",
        "read_statute",
        "read_statute_provisions",
        "read_provision_history",
        "resolve_case_law_decision",
        "resolve_law_citation",
      ]);
      expect(
        listed.tools.find(({ name }) => name === "read_case_law_citations")
          ?._meta?.["ui"],
      ).toMatchObject({
        resourceUri: "ui://stella/citation-graph",
        visibility: ["model", "app"],
      });
      expect(authenticateMcpRequestMock).toHaveBeenCalledWith("token", {
        mode: "law",
        resolveApiKeySession: resolveMachineApiKeySession,
      });
      expect(listMcpToolsMock).toHaveBeenCalledWith(context, "law", [
        "stella:search",
        "stella:read",
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
    authenticateMcpRequestMock.mockResolvedValue(Result.err(error));

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
    expect(observeTransportFailureMock).toHaveBeenCalledWith(error, {
      mode: "default",
      request: expect.any(Request),
    });
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("keeps the authenticated notification stream open until the client cancels", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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

  test("stream sweeps select read-only key verification and preserve retryable failures", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
    resolveMcpSessionContextMock.mockResolvedValue({ type: "mcp-context" });
    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", {
        headers: { accept: "text/event-stream", authorization: "Bearer token" },
        method: "GET",
      }),
    );
    expect(response.status).toBe(200);
    const reader =
      response.body?.getReader() ??
      expect.unreachable("An event stream has a body");
    try {
      expect(authenticateMcpRequestMock).toHaveBeenLastCalledWith("token", {
        mode: "default",
        resolveApiKeySession: resolveMachineApiKeySession,
      });
      await sweepBoundStreams(async () => new Set());
      expect(authenticateMcpRequestMock).toHaveBeenLastCalledWith("token", {
        mode: "default",
        resolveApiKeySession: revalidateMachineApiKeySession,
      });
      authenticateMcpRequestMock.mockResolvedValue(
        Result.err(
          new McpTokenVerificationError({
            message: "Credential store unavailable",
          }),
        ),
      );
      await sweepBoundStreams(async () => new Set());
      // Another sweep reaches the same binding after the retryable failure.
      authenticateMcpRequestMock.mockClear();
      authenticateMcpRequestMock.mockResolvedValue(
        Result.err(
          new McpAuthenticationError({
            message: "Invalid or expired API key",
          }),
        ),
      );
      await sweepBoundStreams(async () => new Set());
      expect(authenticateMcpRequestMock).toHaveBeenCalledTimes(1);
      expect((await reader.read()).done).toBe(true);
    } finally {
      await reader.cancel();
    }
  });

  test("refuses session termination with 405", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );

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
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        credential: { clientId: "client_1", type: "oauth_client" },
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
    resolveMcpSessionContextMock.mockResolvedValue({ type: "mcp-context" });

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {
            extensions: {
              [MCP_APP_EXTENSION_ID]: {
                mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE, "application/private"],
              },
            },
          },
          clientInfo: { name: `  ${"n".repeat(200)}  `, version: "1.2.3" },
          protocolVersion: "2025-06-18",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(
      captured.map(({ distinctId, ...capture }) => ({
        ...capture,
        distinctId: distinctId.toString(),
      })),
    ).toEqual([
      {
        distinctId: "user_1",
        event: "mcp_session_initialized",
        groups: { organization: "org_1" },
        properties: {
          client_name: "n".repeat(128),
          client_version: "1.2.3",
          ui_apps_supported: true,
          ui_apps_mime_types: [MCP_APP_RESOURCE_MIME_TYPE],
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
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        credential: { clientId: "client_1", type: "oauth_client" },
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read", "stella:skills"],
        userId: "user_1",
      }),
    );
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
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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
    expect(response.headers.get("x-stella-scope-omitted-tools")).toBe(
      "save_filled_template",
    );
    // Tests run as a dev deployment, where every feature-gated tool is served.
    expect(response.headers.get("x-stella-feature-omitted-tools")).toBe("");
    expect(response.headers.get("x-stella-feature-omitted-capabilities")).toBe(
      "",
    );
  });

  test("rejects tool calls missing the required scope before dynamic resolution", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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
      _meta: {
        "mcp/www_authenticate": [
          getMcpWwwAuthenticateHeader({ error: "insufficient_scope" }),
        ],
      },
    });
  });

  test("rejects tool calls missing an additional compound scope", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:documents_write"],
        userId: "user_1",
      }),
    );
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
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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
    // Hosts that read tool-level challenges offer to reconnect in place.
    expect(body.result.isError).toBe(true);
    expect(body.result._meta).toEqual({
      "mcp/www_authenticate": [
        getMcpWwwAuthenticateHeader({ error: "insufficient_scope" }),
      ],
    });
    expect(getMcpToolDefinitionMock).not.toHaveBeenCalled();
    expect(handleMcpToolCallMock).not.toHaveBeenCalled();
  });

  for (const definition of LEGAL_RESOLVE_TOOL_SET.definitions) {
    for (const hinted of [true, false]) {
      test.each([
        { scopes: ["stella:read"], admitted: true },
        { scopes: ["stella:law_read"], admitted: true },
        { scopes: ["stella:search"], admitted: false },
        { scopes: [], admitted: false },
      ])(
        `${definition.name} scope admission (hinted=${hinted}, $scopes)`,
        async ({ scopes, admitted }) => {
          authenticateMcpRequestMock.mockResolvedValue(
            Result.ok({ organizationId: "org_1", userId: "user_1", scopes }),
          );
          resolveMcpSessionContextMock.mockResolvedValue({
            type: "mcp-context",
          });
          if (hinted) {
            getMcpToolRequiredScopesHintMock.mockReturnValue([
              definition.scope,
            ]);
          }
          getMcpToolDefinitionMock.mockResolvedValue(definition);
          handleMcpToolCallMock.mockResolvedValue({
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "country_unavailable" }),
              },
            ],
          });
          const response = await handleMcpHttpRequest(
            createMcpRequest({
              id: 1,
              jsonrpc: "2.0",
              method: "tools/call",
              params: { name: definition.name, arguments: {} },
            }),
          );
          const body =
            await readTestJson<McpJsonResponse<CallToolResult>>(response);
          expect(response.status).toBe(200);
          if (admitted) {
            expect(body.result.isError).not.toBe(true);
            expect(handleMcpToolCallMock).toHaveBeenCalledTimes(1);
            return;
          }
          expect(body.result.isError).toBe(true);
          const content = body.result.content.at(0);
          expect(
            content?.type === "text" ? JSON.parse(content.text) : undefined,
          ).toMatchObject({ error: { code: "missing_scope" } });
          expect(handleMcpToolCallMock).not.toHaveBeenCalled();
        },
      );
    }
  }

  test("returns an unknown_tool envelope with closest-name hints", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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

  test("points a call spelled as a chat script function at the tool it means", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
    resolveMcpSessionContextMock.mockResolvedValue({ type: "mcp-context" });
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
        params: { arguments: {}, name: "external_list_matters" },
      }),
    );
    const body = await readTestJson<McpJsonResponse<CallToolResult>>(response);

    const item = body.result.content.at(0);
    const parsed =
      item?.type === "text"
        ? parseUnknownToolErrorEnvelope(item.text)
        : undefined;
    expect(parsed?.error.hint).toBe(
      "No such tool. Did you mean `list_matters`? Call tools/list for the full set.",
    );
  });

  test("does not fuzzy match unusually long unknown tool names", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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

  test("translates an unavailable prompt into an invalid-params protocol error", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
    resolveMcpSessionContextMock.mockResolvedValue({ grantedScopes: [] });

    const response = await handleMcpHttpRequest(
      createMcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "prompts/get",
        params: { name: "skill__unavailable" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await readTestJson<McpJsonRpcError>(response)).toMatchObject({
      error: { code: -32_602, message: "Unknown prompt: skill__unavailable" },
      id: 1,
      jsonrpc: "2.0",
    });
  });

  test("lists static resources for the request mode", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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
    expect(listMcpResourcesMock).toHaveBeenCalledWith("default", {
      type: "mcp-context",
    });
    expect(body.result.resources.map((resource) => resource.uri)).toEqual([
      "stella://reference/template-markers",
    ]);
  });

  test("reads a resource by uri for the request mode", async () => {
    const context = { type: "mcp-context" };
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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
      { type: "mcp-context" },
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
    actionSizePolicyMock.mockReset();
    actionSizePolicyMock.mockImplementation(() => Result.ok(undefined));
    authenticateMcpRequestMock.mockReset();
    captureErrorMock.mockReset();
    observeTransportFailureMock.mockReset();
    listMcpToolsMock.mockReset();
    listMcpToolsMock.mockImplementation(async () => []);
    resolveMcpSessionContextMock.mockReset();
  });

  const authenticateSession = () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: ["stella:read"],
        userId: "user_1",
      }),
    );
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
    authenticateMcpRequestMock.mockResolvedValue(
      Result.err(new McpAuthenticationError({ message: "Token expired" })),
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

  test("parses a JSON-RPC body once on either transport", async () => {
    authenticateSession();
    const parse = spyOn(JSON, "parse");
    try {
      for (const protocol of ["legacy", "modern"] as const) {
        const request =
          protocol === "modern"
            ? createModernMcpRequest({ id: 1, method: "tools/list" })
            : createMcpRequest({
                id: 1,
                jsonrpc: "2.0",
                method: "tools/list",
                params: {},
              });
        const body = await request.clone().text();
        parse.mockClear();

        const response = await handleMcpHttpRequest(request);
        const parses = parse.mock.calls.filter(([text]) => text === body);

        expect({
          protocol,
          status: response.status,
          parses: parses.length,
        }).toEqual({
          protocol,
          status: 200,
          parses: 1,
        });
      }
    } finally {
      parse.mockRestore();
    }
  });

  test("reads no body before the token is accepted", async () => {
    authenticateMcpRequestMock.mockResolvedValue(
      Result.err(new McpAuthenticationError({ message: "Token expired" })),
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

  /**
   * Request headers a browser sends without a preflight naming them (Fetch
   * standard): the CORS-safelisted names, and the forbidden names the user
   * agent alone sets. Every other header the transport reads must be allowed.
   */
  const BROWSER_SENDS_WITHOUT_PREFLIGHT = new Set([
    "accept",
    "accept-language",
    "content-language",
    "range",
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "cookie",
    "date",
    "dnt",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
  ]);

  test("allows on preflight every request header the transport reads", async () => {
    authenticateSession();
    listMcpToolsMock.mockImplementation(async () => []);
    getMcpToolDefinitionMock.mockResolvedValue(undefined);
    const read = new Set<string>();
    const { get, has } = Headers.prototype;
    // Response headers never carry credentials, so a read on a header set
    // holding `Authorization` is a read of the caller's request.
    const isRequestHeaders = (headers: Headers) =>
      has.call(headers, "authorization");
    const getSpy = spyOn(Headers.prototype, "get").mockImplementation(function (
      this: Headers,
      name: string,
    ) {
      if (isRequestHeaders(this)) {
        read.add(name.toLowerCase());
      }
      return get.call(this, name);
    });
    const hasSpy = spyOn(Headers.prototype, "has").mockImplementation(function (
      this: Headers,
      name: string,
    ) {
      if (name.toLowerCase() !== "authorization" && isRequestHeaders(this)) {
        read.add(name.toLowerCase());
      }
      return has.call(this, name);
    });
    try {
      const toolCall = {
        name: "list_matters",
        arguments: {},
      };
      for (const request of [
        createMcpRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
        createMcpRequest({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: toolCall,
        }),
        createModernMcpRequest({ id: 3, method: "tools/list" }),
        createModernMcpRequest({
          id: 4,
          method: "tools/call",
          params: toolCall,
        }),
      ]) {
        const response = await handleMcpHttpRequest(request);
        await response.text();
      }
    } finally {
      getSpy.mockRestore();
      hasSpy.mockRestore();
    }
    const preflight = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", { method: "OPTIONS" }),
    );
    const allowed = new Set(
      (preflight.headers.get("Access-Control-Allow-Headers") ?? "")
        .split(",")
        .map((name) => name.trim().toLowerCase()),
    );

    // The census reaches the headers the modern leg requires.
    expect([...read]).toEqual(
      expect.arrayContaining([
        "mcp-protocol-version",
        "mcp-method",
        "mcp-name",
      ]),
    );
    expect(
      [...read].filter(
        (name) =>
          !allowed.has(name) && !BROWSER_SENDS_WITHOUT_PREFLIGHT.has(name),
      ),
    ).toEqual([]);
  });

  test("refuses actual oversized frames before authentication even with a smaller declared length", async () => {
    actionSizePolicyMock.mockReturnValue(
      Result.ok({
        pageSize: 10,
        requestBytes: 32,
        responseBytes: 512,
      }),
    );
    const oversized = "é".repeat(20);
    for (const declaredLength of [undefined, "1"]) {
      const headers = new Headers({
        authorization: "Bearer token",
        "content-type": "application/json",
      });
      if (declaredLength !== undefined) {
        headers.set("content-length", declaredLength);
      }
      const response = await handleMcpHttpRequest(
        new Request("http://localhost/mcp", {
          body: oversized,
          headers,
          method: "POST",
        }),
      );
      expect(response.status).toBe(413);
      expect(authenticateMcpRequestMock).not.toHaveBeenCalled();
      expect(resolveMcpSessionContextMock).not.toHaveBeenCalled();
    }
  });

  test("meters UTF-8 frame bytes with a smaller declared length on both transports and size-policy branches", async () => {
    authenticateSession();
    const body = JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
      params: { padding: "é".repeat(MCP_MAX_REQUEST_BODY_BYTES / 2) },
    });
    expect(body.length).toBeLessThan(MCP_MAX_REQUEST_BODY_BYTES);
    expect(Buffer.byteLength(body, "utf-8")).toBeGreaterThan(
      MCP_MAX_REQUEST_BODY_BYTES,
    );
    for (const policy of [
      undefined,
      {
        pageSize: 10,
        requestBytes: MCP_MAX_REQUEST_BODY_BYTES * 2,
        responseBytes: 512,
      },
    ]) {
      actionSizePolicyMock.mockReturnValue(Result.ok(policy));
      for (const protocol of ["legacy", "modern"] as const) {
        authenticateMcpRequestMock.mockClear();
        const original =
          protocol === "modern"
            ? createModernMcpRequest({ id: 1, method: "tools/list" })
            : toolsListRequest();
        const headers = new Headers(original.headers);
        headers.set("content-length", "1");
        const response = await handleMcpHttpRequest(
          new Request(original, { body, headers, method: "POST" }),
        );
        expect({ protocol, status: response.status }).toEqual({
          protocol,
          status: 413,
        });
        expect(await readTestJson<McpJsonRpcError>(response)).toEqual({
          error: {
            code: -32_000,
            message: `Payload Too Large: a request body may not exceed ${MCP_MAX_REQUEST_BODY_BYTES} bytes.`,
          },
          id: null,
          jsonrpc: "2.0",
        });
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(authenticateMcpRequestMock).toHaveBeenCalledTimes(1);
        expect(resolveMcpSessionContextMock).not.toHaveBeenCalled();
        expect(listMcpToolsMock).not.toHaveBeenCalled();
      }
    }
  });

  test("cancels an oversized declared-small stream without reading its remaining bytes", async () => {
    authenticateSession();
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          pulls += 1;
          controller.enqueue(new Uint8Array(MCP_MAX_REQUEST_BODY_BYTES + 1));
        },
        cancel: () => {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await handleMcpHttpRequest(
      new Request("http://localhost/mcp", {
        body,
        duplex: "half",
        headers: {
          authorization: "Bearer token",
          "content-length": "1",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(413);
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
    expect(resolveMcpSessionContextMock).not.toHaveBeenCalled();
  });

  test("bounds serialized UTF-8 JSON-RPC envelopes on modern and legacy transports", async () => {
    authenticateSession();
    actionSizePolicyMock.mockReturnValue(
      Result.ok({
        pageSize: 10,
        requestBytes: 2000,
        responseBytes: 512,
      }),
    );
    const tools = [
      {
        description: "😀".repeat(100),
        inputSchema: { properties: {}, type: "object" },
        name: "list_matters",
      },
    ] as const satisfies McpTool[];
    const serialized = JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      result: { tools },
    });
    expect(serialized.length).toBeLessThan(512);
    expect(new TextEncoder().encode(serialized).length).toBeGreaterThan(512);
    listMcpToolsMock.mockResolvedValue(tools);
    for (const protocolVersion of [undefined, MODERN_PROTOCOL_VERSION]) {
      const request =
        protocolVersion === undefined
          ? toolsListRequest()
          : createModernMcpRequest({ id: 1, method: "tools/list" });
      const response = await handleMcpHttpRequest(request);
      expect(response.status).toBe(413);
      expect((await response.arrayBuffer()).byteLength).toBeLessThanOrEqual(
        512,
      );
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  test("bounds tool results by declared read intent while preserving applied mutations on both transports", async () => {
    authenticateSession();
    actionSizePolicyMock.mockReturnValue(
      Result.ok({ pageSize: 10, requestBytes: 2000, responseBytes: 512 }),
    );
    const payload = {
      content: [{ type: "text", text: "é".repeat(400) }],
      structuredContent: { result: "é".repeat(400) },
    };
    const definition = listStaticMcpToolDefinitions("default").find(
      (tool) => tool.scope === "stella:read" && tool.annotations.readOnlyHint,
    );
    if (definition === undefined) {
      panic("Missing read tool fixture");
    }
    for (const intent of ["read", "write", "unannotated"] as const) {
      getMcpToolDefinitionMock.mockResolvedValue({
        ...definition,
        annotations:
          intent === "unannotated"
            ? undefined
            : { ...definition.annotations, readOnlyHint: intent === "read" },
      });
      for (const protocol of ["legacy", "modern"] as const) {
        handleMcpToolCallMock.mockClear();
        handleMcpToolCallMock.mockResolvedValue(payload);
        const params = { name: definition.name, arguments: {} };
        const request =
          protocol === "modern"
            ? createModernMcpRequest({ id: 1, method: "tools/call", params })
            : createMcpRequest({
                id: 1,
                jsonrpc: "2.0",
                method: "tools/call",
                params,
              });
        const response = await handleMcpHttpRequest(request);
        const encoded = await response.text();
        expect({
          status: response.status,
          body: response.status === 200 ? undefined : encoded,
        }).toEqual({ status: 200, body: undefined });
        expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(512);
        const envelope: McpJsonResponse<CallToolResult> = JSON.parse(encoded);
        expect(handleMcpToolCallMock).toHaveBeenCalledTimes(1);
        if (intent === "read") {
          expect(envelope.result.isError).toBe(true);
          expect(envelope.result.content).toEqual([
            {
              type: "text",
              text: expect.stringContaining('"code":"result_too_large"'),
            },
          ]);
          continue;
        }
        expect(envelope.result.isError).toBe(false);
        expect(envelope.result.structuredContent).toEqual({
          applied: true,
          resultOmitted: true,
          reason: "result_too_large",
        });
        expect(envelope.result.content).toEqual([
          { type: "text", text: expect.stringContaining("Action applied.") },
        ]);
      }
    }
  });

  test("an omitted mutation result still validates against the tool's advertised outputSchema", async () => {
    const definition = listStaticMcpToolDefinitions("default").find(
      (tool) =>
        !tool.annotations.readOnlyHint &&
        toMcpTools([tool])[0]?.outputSchema !== undefined,
    );
    const outputSchema =
      definition === undefined
        ? undefined
        : toMcpTools([definition])[0]?.outputSchema;
    if (definition === undefined || outputSchema === undefined) {
      panic("Missing mutation tool with an output contract");
    }
    authenticateMcpRequestMock.mockResolvedValue(
      Result.ok({
        organizationId: "org_1",
        scopes: [definition.scope, ...(definition.additionalScopes ?? [])],
        userId: "user_1",
      }),
    );
    resolveMcpSessionContextMock.mockResolvedValue({ memberRole: "owner" });
    actionSizePolicyMock.mockReturnValue(
      Result.ok({ pageSize: 10, requestBytes: 2000, responseBytes: 512 }),
    );
    getMcpToolDefinitionMock.mockResolvedValue(definition);
    handleMcpToolCallMock.mockResolvedValue({
      content: [{ type: "text", text: "é".repeat(400) }],
    });
    const validate = compileClientWireSchema(
      new AjvJsonSchemaValidator(),
      outputSchema,
    );

    for (const protocol of ["legacy", "modern"] as const) {
      const params = { name: definition.name, arguments: {} };
      const response = await handleMcpHttpRequest(
        protocol === "modern"
          ? createModernMcpRequest({ id: 1, method: "tools/call", params })
          : createMcpRequest({
              id: 1,
              jsonrpc: "2.0",
              method: "tools/call",
              params,
            }),
      );
      const envelope =
        await readTestJson<McpJsonResponse<CallToolResult>>(response);

      // The fixture reaches the omission path: the result is not an error, so
      // a client validates `structuredContent` against the advertised schema.
      expect(envelope.result.isError).toBe(false);
      expect(envelope.result.structuredContent).toMatchObject({
        applied: true,
        resultOmitted: true,
      });
      expect({
        protocol,
        valid: validate(envelope.result.structuredContent).valid,
      }).toEqual({ protocol, valid: true });
    }
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
    expect(omitted.feature).toEqual([...gated].toSorted());
    // A fully granted token omits nothing for scope, so the feature evidence is
    // the complete explanation for what the projection dropped.
    expect(omitted.scope).toEqual([]);
  });

  test("attests each omitted tool under exactly one reason", () => {
    const omitted = mcpOmittedToolNamesByReason({
      grantedScopes: ["stella:read"],
      isFeatureEnabled: (feature) => feature !== "FEATURE_PUBLIC_LAW",
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
