import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  resetAnalyticsForTesting,
  setAnalyticsForTesting,
} from "@/api/lib/analytics/client";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/server-analytics";
import {
  type LogRecord,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { SYNTHETIC_PRINCIPAL } from "@/api/lib/synthetic-principal/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { observeMcpToolCall } from "@/api/mcp/observe-tool-call";
import {
  observeMcpRequest,
  setMcpMetricProtocolPath,
  setMcpMetricToolName,
} from "@/api/mcp/request-metrics";
import { MCP_INTERNAL_TOOL_FAILURE } from "@/api/mcp/tool-call-outcome";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

afterEach(() => {
  resetLogSinkForTesting();
  resetMetricLineSinkForTesting();
  resetAnalyticsForTesting();
});

const customerContext = (overrides: Record<string, unknown> = {}) =>
  asTestRaw<McpRequestContext>({
    organizationId: "org_customer",
    userId: "user_customer",
    sessionCredentialType: "oauth_client",
    ...overrides,
  });

const result = (value: Partial<CallToolResult> = {}): CallToolResult => ({
  content: [{ type: "text", text: "ok" }],
  ...value,
});

const envelope = (code: string, message = "refused"): CallToolResult => ({
  content: [
    { type: "text", text: JSON.stringify({ error: { code, message } }) },
  ],
  isError: true,
});

const toolEvents = (
  events: ReturnType<typeof installRecordingAnalytics>["events"],
) =>
  events.filter(({ event }) => event === SERVER_ANALYTICS_EVENTS.mcpToolCalled);

describe("MCP tool product analytics", () => {
  test("does not copy hostile call data or a tenant-defined tool name", async () => {
    const marker = "HOSTILE_PRIVATE_MARKER_7f02";
    const recording = installRecordingAnalytics();
    const hostileArguments = { query: marker };

    await observeMcpToolCall({
      context: customerContext(),
      mode: "default",
      toolName: `tenant_${marker}`,
      run: async () => {
        expect(hostileArguments.query).toBe(marker);
        return {
          content: [{ type: "text", text: marker }],
          structuredContent: { document: marker },
          isError: true,
        };
      },
    });

    const captured = toolEvents(recording.events);
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured.at(0))).not.toContain(marker);
    expect(captured.at(0)?.properties).toMatchObject({ tool: "unknown" });
  });

  test("does not copy a hostile refusal code or message", async () => {
    const marker = "HOSTILE_PRIVATE_MARKER_c41d";
    const recording = installRecordingAnalytics();

    await observeMcpToolCall({
      context: customerContext(),
      mode: "default",
      toolName: "list_matters",
      run: async () => envelope(`code_${marker}`, `message ${marker}`),
    });

    const captured = toolEvents(recording.events);
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured.at(0))).not.toContain(marker);
    expect(captured.at(0)?.properties).toMatchObject({
      outcome: "refused",
      error_code: "unknown",
    });
  });

  test("does not copy a thrown error's message", async () => {
    const marker = "HOSTILE_PRIVATE_MARKER_9b3e";
    const failure = new Error(`failed on ${marker}`);
    const recording = installRecordingAnalytics();

    const rejection = await rejectionOf(
      observeMcpToolCall({
        context: customerContext(),
        mode: "default",
        toolName: "list_matters",
        run: async () => {
          throw failure;
        },
      }),
    );
    expect(rejection).toBe(failure);
    expect(String(rejection)).toContain(marker);

    const captured = toolEvents(recording.events);
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured.at(0))).not.toContain(marker);
    expect(captured.at(0)?.properties).toMatchObject({
      outcome: "internal_error",
      error_class: "unknown",
    });
  });

  test.each([
    ["ok", result(), {}],
    ["refused", envelope("not_found"), { error_code: "not_found" }],
    ["refused", envelope("tenant_private_code"), { error_code: "unknown" }],
    ["tool_error", result({ isError: true }), {}],
    [
      "internal_error",
      { ...envelope("internal_error"), [MCP_INTERNAL_TOOL_FAILURE]: true },
      { error_class: "unknown" },
    ],
  ] as const)(
    "reports %s without payload data",
    async (outcome, callResult, extra) => {
      const recording = installRecordingAnalytics();
      await observeMcpToolCall({
        context: customerContext(),
        mode: "default",
        toolName: "list_matters",
        run: async () => callResult,
      });

      expect(toolEvents(recording.events).at(0)?.properties).toMatchObject({
        outcome,
        ...extra,
      });
    },
  );

  test("does not report service principals", async () => {
    const recording = installRecordingAnalytics();
    await observeMcpToolCall({
      context: customerContext({
        organizationId: SYNTHETIC_PRINCIPAL.org.id,
        userId: SYNTHETIC_PRINCIPAL.user.id,
      }),
      mode: "default",
      toolName: "list_matters",
      run: async () => result(),
    });
    expect(toolEvents(recording.events)).toHaveLength(0);
  });

  test("a throwing analytics client cannot alter the tool result", async () => {
    setAnalyticsForTesting({
      capture: () => {
        throw new Error("analytics unavailable");
      },
      identifyOrganizationGroup: () => undefined,
      flush: async () => await Promise.resolve(),
    });
    const expected = result({ structuredContent: { safe: true } });
    const actual = await observeMcpToolCall({
      context: customerContext(),
      mode: "default",
      toolName: "list_matters",
      run: async () => expected,
    });
    expect(actual).toBe(expected);
  });

  test("nested admission and execution emit one modern-transport event", async () => {
    const recording = installRecordingAnalytics();
    const context = customerContext();
    await observeMcpRequest({
      method: "tools/call",
      mode: "default",
      run: async () => {
        setMcpMetricProtocolPath("modern");
        return await observeMcpToolCall({
          context,
          mode: "default",
          toolName: "list_matters",
          run: async () =>
            await observeMcpToolCall({
              context,
              mode: "default",
              toolName: "list_matters",
              run: async () => result(),
            }),
        });
      },
    });
    const captured = toolEvents(recording.events);
    expect(captured).toHaveLength(1);
    expect(captured.at(0)?.properties).toMatchObject({ transport: "modern" });
  });
});

test.each([
  "list_matters",
  "mcp__tenant_connector__lookup",
  "skill__tenant_research",
  "tenant_supplied_unknown",
])(
  "phase and tool-call observations classify %s identically",
  async (toolName) => {
    const logRecords: LogRecord[] = [];
    const metricLines: string[] = [];
    setLogSinkForTesting((record) => {
      logRecords.push(record);
    });
    setMetricLineSinkForTesting((line) => {
      metricLines.push(line);
    });
    const context = asTestRaw<AuthorizedMcpRequestContext>({});
    const callResult: CallToolResult = {
      content: [{ type: "text", text: "ok" }],
    };

    await observeMcpRequest({
      method: "tools/call",
      mode: "default",
      run: async () => {
        setMcpMetricToolName(toolName, "default");
        return await observeMcpToolCall({
          context,
          mode: "default",
          toolName,
          run: async () => callResult,
        });
      },
    });

    const toolCallRecord = logRecords.find(
      ({ message }) => message === "mcp.tool_call.completed",
    );
    const phaseRecord = metricLines
      .map((line) => JSON.parse(line))
      .find((record) => record.event === "mcp.request.phases");
    expect(phaseRecord?.toolName).toBe(toolCallRecord?.attributes?.["tool"]);
  },
);
