import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  callGatewayExternalMcpTool,
  gatewayLoadErrorResult,
  recordSkillGatewayToolAudit,
} from "@/api/mcp/gateway/external-tools";
import type { ResolvedSkillTool } from "@/api/mcp/gateway/skills";
import { resolveSkillTool } from "@/api/mcp/gateway/skills";
import type { InternalToolResult } from "@/api/mcp/tool-types";
import { structuredErrorResult, toolDataResult } from "@/api/mcp/tool-utils";

export type GatewayDispatchDependencies = {
  callGatewayExternalMcpTool: typeof callGatewayExternalMcpTool;
  gatewayLoadErrorResult: typeof gatewayLoadErrorResult;
  recordSkillGatewayToolAudit: typeof recordSkillGatewayToolAudit;
  resolveSkillTool: typeof resolveSkillTool;
};

const defaultDependencies: GatewayDispatchDependencies = {
  callGatewayExternalMcpTool,
  gatewayLoadErrorResult,
  recordSkillGatewayToolAudit,
  resolveSkillTool,
};

export type GatewayDispatchResult =
  | { type: "external_mcp"; result: CallToolResult }
  | { type: "internal"; result: InternalToolResult };

export const dispatchGatewayToolCall = async ({
  args,
  context,
  mode,
  toolName,
  dependencies = defaultDependencies,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
  mode: McpMode;
  toolName: string;
  dependencies?: GatewayDispatchDependencies;
}): Promise<GatewayDispatchResult | null> => {
  if (mode !== "default") {
    return null;
  }

  if (isExternalMcpToolName(toolName)) {
    return {
      type: "external_mcp",
      result: await dependencies.callGatewayExternalMcpTool({
        args,
        context,
        toolName,
      }),
    };
  }

  if (!isSkillToolName(toolName)) {
    return null;
  }

  const startedAt = Date.now();
  let skill: ResolvedSkillTool | null;
  try {
    skill = await dependencies.resolveSkillTool({ context, toolName });
  } catch (error) {
    // A load fault means we cannot tell whether the skill exists: answer with a
    // retryable error, never a definitive `unknown_tool`.
    const loadError = dependencies.gatewayLoadErrorResult(error);
    if (loadError) {
      return { type: "internal", result: loadError };
    }
    throw error;
  }
  if (!skill) {
    return {
      type: "internal",
      result: structuredErrorResult({
        code: "unknown_tool",
        message: `Unknown tool: ${toolName}`,
        hint: "Call tools/list for the tools available to this session.",
      }),
    };
  }

  await dependencies.recordSkillGatewayToolAudit({
    context,
    durationMs: Date.now() - startedAt,
    outcome: "success",
    skillId: skill.id,
    toolName,
  });

  return {
    type: "internal",
    result: toolDataResult({
      body: skill.body,
      compatibility: skill.compatibility,
      license: skill.license,
      metadata: skill.metadata,
      name: skill.slug,
      origin: skill.origin,
      version: skill.version,
    }),
  };
};
