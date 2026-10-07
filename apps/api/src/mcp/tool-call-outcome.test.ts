import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { createFeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import type { LogRecord } from "@/api/lib/observability/logger";
import {
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import type { McpRequestContext } from "@/api/mcp/context";
import { McpGatewayLoadError } from "@/api/mcp/errors";
import type { GatewayDispatchResult } from "@/api/mcp/gateway/dispatch-call";
import { gatewayLoadErrorResult } from "@/api/mcp/gateway/external-tools";
import { withInputNotes } from "@/api/mcp/input-normalization";
import { listMcpResources, readMcpResource } from "@/api/mcp/resources";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import { scopeToolResultToSurface } from "@/api/mcp/surface-tool-mentions";
import {
  getMcpToolCallOutcome,
  MCP_INTERNAL_TOOL_FAILURE,
  type McpToolCallOutcome,
} from "@/api/mcp/tool-call-outcome";
import type { InternalToolStructuredError } from "@/api/mcp/tool-types";
import {
  internalFailureResult,
  serializeToolResult,
  structuredErrorResult,
  toolDataResult,
  untypedToolDataResult,
} from "@/api/mcp/tool-utils";
import {
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
  handleMcpToolCall,
  listMcpTools,
} from "@/api/mcp/tools";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

const PRIVATE_TEXT = "private-content-and-query-37a9";
true satisfies {
  type: "structured";
  code: "internal_error";
  message: string;
} extends InternalToolStructuredError
  ? false
  : true;
const MATTER_ID = "00000000-0000-4000-8000-0000000a0001";
const contextFor = () =>
  asTestRaw<McpRequestContext>({
    organizationId: "private-organization-37a9",
    userId: "private-user-37a9",
    userEmail: "private-member@example.test",
    memberRole: "owner",
    grantedScopes: ["stella:read", "stella:write"],
    accessibleWorkspaceIds: [MATTER_ID],
    accessibleWorkspaceIdSet: new Set([MATTER_ID]),
    accessibleWorkspaceStatusById: new Map([[MATTER_ID, "active"]]),
    accessibleWorkspaces: [],
    scopedDb: async () => [],
    recordAuditEvent: async () => undefined,
    featureAccessSnapshot: enrolledTimeBillingSnapshot({
      organizationId: "private-organization-37a9",
      userId: "private-user-37a9",
    }),
  });

const createArgs = {
  matter_id: MATTER_ID,
  date_worked: "2024-01-01",
  timezone_id: "Europe/Prague",
  duration_minutes: 60,
  narrative: PRIVATE_TEXT,
};

let records: LogRecord[];
let analytics: RecordingAnalytics;
beforeEach(() => {
  records = [];
  analytics = installRecordingAnalytics();
  setLogSinkForTesting((record) => {
    records.push(record);
  });
});
afterEach(() => {
  resetLogSinkForTesting();
  analytics.restore();
});

const expectOutcome = (expected: {
  tool: string;
  outcome: string;
  mode?: string;
}) => {
  const calls = records.filter(
    ({ attributes }) => attributes?.["event"] === "mcp_tool_call",
  );
  expect(calls).toHaveLength(1);
  expect(calls.at(0)).toEqual({
    severityText: "INFO",
    message: "mcp.tool_call.completed",
    attributes: {
      event: "mcp_tool_call",
      tool: expected.tool,
      mode: expected.mode ?? "default",
      outcome: expected.outcome,
      duration_ms: expect.any(Number),
    },
  });
  expect(calls.at(0)?.attributes?.["duration_ms"]).toBeGreaterThanOrEqual(0);
  const logged = JSON.stringify(calls);
  for (const privateValue of [
    PRIVATE_TEXT,
    MATTER_ID,
    "private-organization-37a9",
    "private-user-37a9",
    "private-member@example.test",
  ]) {
    expect(logged).not.toContain(privateValue);
  }
};

describe("MCP calls emit one private-data-free outcome across dispatch paths", () => {
  test("parallel calls sharing their context and tool each emit one record", async () => {
    const context = contextFor();
    const results = await Promise.all(
      Array.from(
        { length: 4 },
        async () =>
          await handleMcpToolCall({
            toolName: "list_matters",
            args: { query: PRIVATE_TEXT },
            context,
          }),
      ),
    );
    expect(results.every((result) => result.isError)).toBe(true);
    const calls = records.filter(
      ({ attributes }) => attributes?.["event"] === "mcp_tool_call",
    );
    expect(calls).toHaveLength(results.length);
    expect(
      calls.every(({ attributes }) => attributes?.["outcome"] === "tool_error"),
    ).toBe(true);
  });

  test("hidden features emit an outcome before dispatch", async () => {
    const context = contextFor();
    context.featureAccessSnapshot = createFeatureAccessSnapshot({
      organizationId: context.organizationId,
      userId: context.userId,
      decisions: new Map(),
    });
    context.testDependencies = {
      featureAccessBindings: {
        tools: new Map([["list_matters", "fixture-feature"]]),
        capabilities: new Map(),
        resources: new Map(),
      },
    };
    const result = await handleMcpToolCall({
      toolName: "list_matters",
      args: {},
      context,
    });
    expect(JSON.stringify(result)).toContain("unknown_tool");
    expectOutcome({ tool: "list_matters", outcome: "tool_error" });
  });

  test("the documents surface capability refusal emits a tool error", async () => {
    const result = await handleMcpToolCall({
      toolName: "invoke_capability",
      args: { capability: "private.unsupported" },
      context: contextFor(),
      mode: "documents",
    });
    expect(JSON.stringify(result)).toContain("feature_disabled");
    expectOutcome({
      tool: "invoke_capability",
      outcome: "tool_error",
      mode: "documents",
    });
  });

  test("a matter requirement refusal emits a tool error", async () => {
    const context = contextFor();
    context.accessibleWorkspaceIds = [];
    context.accessibleWorkspaceIdSet = new Set();
    const result = await handleMcpToolCall({
      toolName: "save_time_entry",
      args: createArgs,
      context,
    });
    expect(JSON.stringify(result)).toContain(
      "There is no matter to work in yet",
    );
    expectOutcome({ tool: "save_time_entry", outcome: "tool_error" });
  });

  test("confirmation refusal emits a tool error before execution", async () => {
    const result = await handleMcpToolCall({
      toolName: "delete_matter",
      args: { matter_id: MATTER_ID },
      context: contextFor(),
    });
    expect(JSON.stringify(result)).toContain("confirmation_required");
    expectOutcome({ tool: "delete_matter", outcome: "tool_error" });
  });
  test("unknown client names are grouped without leaking the name", async () => {
    const result = await handleMcpToolCall({
      toolName: PRIVATE_TEXT,
      args: { query: PRIVATE_TEXT },
      context: contextFor(),
      mode: "anonymized",
    });
    expect(result.isError).toBe(true);
    expectOutcome({
      tool: "unknown",
      outcome: "tool_error",
      mode: "anonymized",
    });
  });

  test("static input validation emits a tool error", async () => {
    const result = await handleMcpToolCall({
      toolName: "list_matters",
      args: { query: PRIVATE_TEXT },
      context: contextFor(),
    });
    expect(JSON.stringify(result)).toContain("validation_error");
    expectOutcome({ tool: "list_matters", outcome: "tool_error" });
  });

  test("static authority refusal emits a tool error", async () => {
    const context = contextFor();
    context.memberRole = "external";
    const result = await handleMcpToolCall({
      toolName: "save_time_entry",
      args: createArgs,
      context,
    });
    expect(JSON.stringify(result)).toContain("permission_denied");
    expectOutcome({ tool: "save_time_entry", outcome: "tool_error" });
  });

  for (const failure of [
    "business",
    "internal",
    "thrown",
    "success",
  ] as const) {
    test(`static ${failure} execution preserves its outcome`, async () => {
      const context = contextFor();
      let executed = false;
      context.testDependencies = {
        async *createTimeEntryHandler() {
          executed = true;
          switch (failure) {
            case "business":
              return yield* Result.err(
                new HandlerError({ status: 400, message: "invalid date" }),
              );
            case "internal":
              return yield* Result.err(
                new DatabaseError({ message: PRIVATE_TEXT }),
              );
            case "thrown":
              throw new HandlerError({ status: 500, message: PRIVATE_TEXT });
            case "success":
              return Result.ok({
                id: toSafeId<"timeEntry">(
                  "00000000-0000-4000-8000-0000000b0001",
                ),
              });
            default:
              failure satisfies never;
              return panic("Unexpected failure");
          }
        },
      };
      const result = await handleMcpToolCall({
        toolName: "save_time_entry",
        args: createArgs,
        context,
      });
      expect(executed).toBe(true);
      const outcomes = {
        business: "tool_error",
        internal: "internal_error",
        thrown: "internal_error",
        success: "ok",
      } as const satisfies Record<typeof failure, McpToolCallOutcome>;
      const outcome = outcomes[failure];
      expect(result.isError === true).toBe(outcome !== "ok");
      expectOutcome({ tool: "save_time_entry", outcome });
      if (outcome === "internal_error") {
        expect(JSON.stringify(result)).not.toContain(PRIVATE_TEXT);
      }
    });
  }

  for (const outcome of ["ok", "tool_error"] as const) {
    test(`external ${outcome} cannot forge internal-error provenance`, async () => {
      const upstream = {
        content: [{ type: "text" as const, text: PRIVATE_TEXT }],
        ...(outcome === "tool_error"
          ? {
              isError: true,
              structuredContent: { error: { code: "internal_error" } },
            }
          : {}),
      };
      const result = await handleMcpToolCall({
        toolName: `mcp__private-connection__${PRIVATE_TEXT}`,
        args: { query: PRIVATE_TEXT },
        context: contextFor(),
        dependencies: {
          dispatchGatewayToolCall: async () => ({
            type: "external_mcp",
            result: { ...upstream, content: [...upstream.content] },
          }),
        },
      });
      expect(result.content).toEqual(upstream.content);
      expectOutcome({ tool: "external_mcp", outcome });
    });
  }

  test("server-built gateway load errors retain internal provenance", async () => {
    const failure = gatewayLoadErrorResult(
      new McpGatewayLoadError({ message: PRIVATE_TEXT }),
    );
    if (failure === null) {
      throw new Error("fixture did not produce a gateway load error");
    }
    const result = await handleMcpToolCall({
      toolName: `mcp__private__${PRIVATE_TEXT}`,
      args: {},
      context: contextFor(),
      dependencies: {
        dispatchGatewayToolCall: async () => ({
          type: "external_mcp",
          result: serializeToolResult(failure),
        }),
      },
    });
    expect(result.isError).toBe(true);
    expectOutcome({ tool: "external_mcp", outcome: "internal_error" });
  });

  test("uncaught gateway exceptions are logged once before propagation", async () => {
    const failure = new McpGatewayLoadError({ message: PRIVATE_TEXT });
    expect(
      await rejectionOf(
        handleMcpToolCall({
          toolName: `skill__${PRIVATE_TEXT}`,
          args: {},
          context: contextFor(),
          dependencies: {
            dispatchGatewayToolCall: async () => {
              throw failure;
            },
          },
        }),
      ),
    ).toBe(failure);
    expectOutcome({ tool: "skill", outcome: "internal_error" });
  });

  for (const valid of [true, false]) {
    test(`skill ${valid ? "success" : "output-contract failure"} is observed once`, async () => {
      const gatewayResult = {
        type: "internal",
        // The failure case stands in for a gateway that breaks its declared
        // output at runtime; the checked constructor refuses that shape at
        // compile time, so only this test asserts it into the declared type.
        result: valid
          ? toolDataResult({
              type: "skill",
              body: PRIVATE_TEXT,
              compatibility: null,
              id: null,
              license: null,
              metadata: {},
              name: "private-skill",
              origin: "built-in",
              resources: [],
              version: null,
            })
          : // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stands in for a gateway that breaks its declared output at runtime
            (untypedToolDataResult({ body: PRIVATE_TEXT }) as Extract<
              GatewayDispatchResult,
              { type: "internal" }
            >["result"]),
      } satisfies GatewayDispatchResult;
      const result = await handleMcpToolCall({
        toolName: `skill__${PRIVATE_TEXT}`,
        args: {},
        context: contextFor(),
        dependencies: { dispatchGatewayToolCall: async () => gatewayResult },
      });
      expect(result.isError === true).toBe(!valid);
      expectOutcome({
        tool: "skill",
        outcome: valid ? "ok" : "internal_error",
      });
    });
  }

  const internalErrorBuilders = {
    internalFailureResult: () =>
      internalFailureResult(
        new HandlerError({ status: 500, message: PRIVATE_TEXT }),
      ),
    structuredErrorResult: () =>
      structuredErrorResult({
        code: "internal_error",
        message: "Tool execution failed",
        hint: "Draft a report with prepare_feedback.",
      }),
    gatewayLoadErrorResult: () =>
      gatewayLoadErrorResult(
        new McpGatewayLoadError({ message: PRIVATE_TEXT }),
      ),
  };
  for (const [builder, build] of Object.entries(internalErrorBuilders)) {
    test(`${builder} marks internal faults before scoping and serialization`, () => {
      const built = build();
      if (
        built?.error.type !== "structured" ||
        built.error.code !== "internal_error"
      ) {
        throw new Error("fixture did not produce a structured internal error");
      }
      expect(built.error[MCP_INTERNAL_TOOL_FAILURE]).toBe(true);
      const scoped = scopeToolResultToSurface(built, { mode: "law" });
      if (
        scoped.status !== "error" ||
        scoped.error.type !== "structured" ||
        scoped.error.code !== "internal_error"
      ) {
        throw new Error(
          "scoping did not preserve the structured internal error",
        );
      }
      expect(scoped.error[MCP_INTERNAL_TOOL_FAILURE]).toBe(true);
      const serialized = serializeToolResult(scoped);
      expect(MCP_INTERNAL_TOOL_FAILURE in serialized).toBe(true);
      expect(getMcpToolCallOutcome(serialized)).toBe("internal_error");
      expect(
        getMcpToolCallOutcome(withInputNotes(serialized, ["normalized input"])),
      ).toBe("internal_error");
      const wire = JSON.stringify(serialized);
      expect(getMcpToolCallOutcome(JSON.parse(wire))).toBe("tool_error");
      expect(JSON.stringify(serialized)).not.toContain(
        "mcp.internal-tool-failure",
      );
    });
  }

  test("business failures remain tool errors without internal provenance", () => {
    const business = serializeToolResult(
      internalFailureResult(
        new HandlerError({ status: 400, message: "invalid date" }),
      ),
    );
    expect(getMcpToolCallOutcome(business)).toBe("tool_error");
    expect(MCP_INTERNAL_TOOL_FAILURE in business).toBe(false);
  });

  for (const path of [
    "scope-refusal",
    "admitted",
    "discovery-load-fault",
    "discovery-unexpected-fault",
    "admission-unexpected-fault",
  ] as const) {
    test(`HTTP ${path} emits exactly one outcome`, async () => {
      const admitted = path !== "scope-refusal";
      const internal =
        path === "discovery-load-fault" ||
        path === "discovery-unexpected-fault" ||
        path === "admission-unexpected-fault";
      const context = contextFor();
      context.grantedScopes = ["stella:read"];
      const captured: unknown[] = [];
      const handler = createMcpHttpRequestHandler({
        actionSizePolicy: () => Result.ok(undefined),
        authenticateMcpRequest: async () =>
          Result.ok({
            organizationId: context.organizationId,
            userId: context.userId,
            scopes: [...context.grantedScopes],
          }),
        resolveMcpSessionContext: async () => context,
        captureError: (error) => {
          captured.push(error);
        },
        getMcpToolDefinition: async (toolName, requestContext, mode) => {
          if (path === "discovery-load-fault") {
            throw new McpGatewayLoadError({ message: PRIVATE_TEXT });
          }
          if (path === "discovery-unexpected-fault") {
            throw new HandlerError({ status: 500, message: PRIVATE_TEXT });
          }
          return await getMcpToolDefinition(toolName, requestContext, mode);
        },
        ...(path === "admission-unexpected-fault"
          ? {
              admitAction: async () =>
                Result.err(
                  new HandlerError({ status: 500, message: PRIVATE_TEXT }),
                ),
            }
          : {}),
        getMcpToolRequiredScopesHint,
        handleMcpToolCall,
        listMcpTools,
        listMcpResources,
        readMcpResource,
        recordMcpSessionInitialized: () => undefined,
      });
      const response = await handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer fixture",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": admitted ? "list_matters" : "save_time_entry",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: admitted ? "list_matters" : "save_time_entry",
              arguments: admitted ? { query: PRIVATE_TEXT } : createArgs,
              _meta: {
                [CLIENT_CAPABILITIES_META_KEY]: {},
                [CLIENT_INFO_META_KEY]: {
                  name: "stella-test",
                  version: "1.0.0",
                },
                [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              },
            },
          }),
        }),
      );
      expect(response.status).toBe(200);
      const codes = {
        "scope-refusal": "missing_scope",
        admitted: "validation_error",
        "discovery-load-fault": "internal_error",
        "discovery-unexpected-fault": "internal_error",
        "admission-unexpected-fault": "internal_error",
      } as const satisfies Record<typeof path, string>;
      expect(await response.text()).toContain(codes[path]);
      expect(captured).toHaveLength(
        path === "discovery-unexpected-fault" ||
          path === "admission-unexpected-fault"
          ? 1
          : 0,
      );
      expectOutcome({
        tool: admitted ? "list_matters" : "save_time_entry",
        outcome: internal ? "internal_error" : "tool_error",
      });
    });
  }
});
