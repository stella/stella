import type { CallToolResult } from "@modelcontextprotocol/server";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
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
    let outcome: McpToolCallOutcome = "internal_error";
    try {
      const result = await run();
      outcome = getMcpToolCallOutcome(result);
      return result;
    } finally {
      // Dynamic and unknown names can contain client identifiers; retain only
      // their family. Static names come from the canonical registry.
      const definition = getStaticMcpToolDefinition(toolName, mode);
      let tool = "unknown";
      if (definition !== undefined) {
        tool = definition.name;
      } else if (isExternalMcpToolName(toolName)) {
        tool = "external_mcp";
      } else if (isSkillToolName(toolName)) {
        tool = "skill";
      }
      logger.info("mcp.tool_call.completed", {
        event: "mcp_tool_call",
        tool,
        mode,
        outcome,
        duration_ms: performance.now() - startedAt,
      });
    }
  });
};
