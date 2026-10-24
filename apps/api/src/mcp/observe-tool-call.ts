import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic, Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { getServerAnalytics } from "@/api/lib/analytics/client";
import {
  SERVER_ANALYTICS_EVENTS,
  type McpInternalErrorClass,
  type McpToolCalledProperties,
} from "@/api/lib/analytics/server-analytics";
import { productUsagePrincipal } from "@/api/lib/auth/principal-audience";
import { getReviewAccountConfig } from "@/api/lib/auth/review-account";
import {
  FetchBoundaryError,
  TimeoutError,
} from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { classifyMcpMetricToolName } from "@/api/mcp/metric-tool-name";
import { currentMcpMetricTransport } from "@/api/mcp/request-metrics";
import {
  getMcpToolCallAnalyticsOutcome,
  type McpToolCallAnalyticsOutcome,
} from "@/api/mcp/tool-call-outcome";

type ObserveMcpToolCallOptions = {
  context: McpRequestContext;
  mode: McpMode;
  toolName: string;
  run: () => Promise<CallToolResult>;
};

const activeCall = new AsyncLocalStorage<
  Omit<ObserveMcpToolCallOptions, "run">
>();

export { classifyMcpMetricToolName } from "@/api/mcp/metric-tool-name";

const classifyInternalError = (error: unknown): McpInternalErrorClass => {
  if (error instanceof TimeoutError) {
    return "timeout";
  }
  if (error instanceof FetchBoundaryError) {
    return "upstream";
  }
  return "unknown";
};

const captureMcpToolCalled = ({
  context,
  mode,
  toolName,
  durationMs,
  resultOutcome,
  thrownError,
}: Omit<ObserveMcpToolCallOptions, "run"> & {
  durationMs: number;
  resultOutcome: McpToolCallAnalyticsOutcome;
  thrownError?: unknown;
}): void => {
  const principal = productUsagePrincipal(context, getReviewAccountConfig());
  if (principal === null) {
    return;
  }
  const base = {
    tool: classifyMcpMetricToolName(toolName, mode),
    mode,
    duration_ms: Math.max(0, Math.round(durationMs)),
    credential_type: context.sessionCredentialType ?? "unspecified",
    transport: currentMcpMetricTransport(),
  } as const;
  const properties: McpToolCalledProperties = (() => {
    switch (resultOutcome.outcome) {
      case "ok":
      case "tool_error":
        return { ...base, outcome: resultOutcome.outcome };
      case "refused":
        return {
          ...base,
          outcome: resultOutcome.outcome,
          error_code: resultOutcome.errorCode,
        };
      case "internal_error":
        return {
          ...base,
          outcome: resultOutcome.outcome,
          error_class: classifyInternalError(thrownError),
        };
      default: {
        resultOutcome satisfies never;
        return panic("Unhandled MCP tool analytics outcome");
      }
    }
  })();

  // Product analytics is queued synchronously by the adapter. Treat even a
  // broken replacement as telemetry-only: it cannot replace the tool result.
  Result.try({
    try: () =>
      getServerAnalytics().capture({
        distinctId: principal.distinctId,
        event: SERVER_ANALYTICS_EVENTS.mcpToolCalled,
        groups: { organization: principal.organizationId },
        properties,
      }),
    catch: (cause) => cause,
  });
};

/** Transport admission and execution share one observation; direct dispatch owns its own. */
export const observeMcpToolCall = async ({
  context,
  mode,
  toolName,
  run,
}: ObserveMcpToolCallOptions): Promise<CallToolResult> => {
  const active = activeCall.getStore();
  if (
    active?.context === context &&
    active.mode === mode &&
    active.toolName === toolName
  ) {
    return await run();
  }
  return await activeCall.run({ context, mode, toolName }, async () => {
    const startedAt = performance.now();
    let resultOutcome: McpToolCallAnalyticsOutcome = {
      outcome: "internal_error",
    };
    let thrownError: unknown;
    try {
      const result = await run();
      resultOutcome = getMcpToolCallAnalyticsOutcome(result);
      return result;
    } catch (error) {
      thrownError = error;
      throw error;
    } finally {
      const durationMs = performance.now() - startedAt;
      logger.info("mcp.tool_call.completed", {
        event: "mcp_tool_call",
        tool: classifyMcpMetricToolName(toolName, mode),
        mode,
        outcome: resultOutcome.outcome,
        duration_ms: durationMs,
      });
      captureMcpToolCalled({
        context,
        mode,
        toolName,
        durationMs,
        resultOutcome,
        ...(thrownError === undefined ? {} : { thrownError }),
      });
    }
  });
};
