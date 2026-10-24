import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, expect, test } from "bun:test";

import {
  type LogRecord,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import type { McpRequestContext } from "@/api/mcp/context";
import { observeMcpToolCall } from "@/api/mcp/observe-tool-call";
import {
  observeMcpRequest,
  setMcpMetricToolName,
} from "@/api/mcp/request-metrics";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

afterEach(() => {
  resetLogSinkForTesting();
  resetMetricLineSinkForTesting();
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
    const context = asTestRaw<McpRequestContext>({});
    const result: CallToolResult = {
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
          run: async () => result,
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
