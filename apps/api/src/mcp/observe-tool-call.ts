import type { CallToolResult } from "@modelcontextprotocol/server";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import { withExceptionScope } from "@/api/lib/observability/exception-scope";
import { logger } from "@/api/lib/observability/logger";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import {
  getMcpToolCallOutcome,
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

/** Keeps tenant-defined names out of telemetry while preserving static names. */
export const classifyMcpMetricToolName = (
  toolName: string,
  mode: McpMode,
): string => {
  const definition = getStaticMcpToolDefinition(toolName, mode);
  if (definition !== undefined) {
    return definition.name;
  }
  if (isExternalMcpToolName(toolName)) {
    return "external_mcp";
  }
  if (isSkillToolName(toolName)) {
    return "skill";
  }
  return "unknown";
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
        let outcome: McpToolCallOutcome = "internal_error";
        try {
          const result = await run();
          outcome = getMcpToolCallOutcome(result);
          return result;
        } finally {
          logger.info("mcp.tool_call.completed", {
            event: "mcp_tool_call",
            tool,
            mode,
            outcome,
            duration_ms: performance.now() - startedAt,
          });
        }
      }),
  );
};
