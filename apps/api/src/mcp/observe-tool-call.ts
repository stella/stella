import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic, Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { getServerAnalytics } from "@/api/lib/analytics/client";
import {
  type McpInternalErrorClass,
  type McpToolCalledProperties,
  SERVER_ANALYTICS_EVENTS,
} from "@/api/lib/analytics/server-analytics";
import { productUsagePrincipal } from "@/api/lib/auth/principal-audience";
import { getReviewAccountConfig } from "@/api/lib/auth/review-account";
import {
  FetchBoundaryError,
  TimeoutError,
} from "@/api/lib/errors/tagged-errors";
import { withExceptionScope } from "@/api/lib/observability/exception-scope";
import { reportEmitFailure } from "@/api/lib/observability/failure-shadow";
import { logger } from "@/api/lib/observability/logger";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { classifyMcpMetricToolName } from "@/api/mcp/metric-tool-name";
import { currentMcpMetricTransport } from "@/api/mcp/request-metrics";
import {
  getMcpToolCallAnalyticsOutcome,
  getMcpToolCallOutcome,
  type McpToolCallAnalyticsOutcome,
  type McpToolCallOutcome,
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
  const sent = Result.try({
    try: () =>
      getServerAnalytics().capture({
        distinctId: principal.distinctId,
        event: SERVER_ANALYTICS_EVENTS.mcpToolCalled,
        groups: { organization: principal.organizationId },
        properties,
      }),
    catch: (cause) => cause,
  });
  if (sent.isErr()) {
    reportEmitFailure("capture", sent.error);
  }
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
  const tool = classifyMcpMetricToolName(toolName, mode);
  return await withExceptionScope(
    { type: "handler", handlerId: `mcp.tool.${mode}.${tool}` },
    async () =>
      await activeCall.run({ context, mode, toolName }, async () => {
        const startedAt = performance.now();
        let resultOutcome: McpToolCallAnalyticsOutcome = {
          outcome: "internal_error",
        };
        let outcome: McpToolCallOutcome = "internal_error";
        let thrownError: unknown;
        try {
          const result = await run();
          outcome = getMcpToolCallOutcome(result);
          resultOutcome = getMcpToolCallAnalyticsOutcome(result);
          return result;
        } catch (error) {
          thrownError = error;
          throw error;
        } finally {
          const durationMs = performance.now() - startedAt;
          logger.info("mcp.tool_call.completed", {
            event: "mcp_tool_call",
            tool,
            mode,
            outcome,
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
      }),
  );
};
