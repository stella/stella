import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
import { structuredErrorResult, textResult } from "@/api/mcp/tool-utils";

export const dispatchGatewayToolCall = async ({
  args,
  context,
  mode,
  toolName,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
  mode: McpMode;
  toolName: string;
}): Promise<CallToolResult | null> => {
  if (mode === "anonymized") {
    return null;
  }

  if (isExternalMcpToolName(toolName)) {
    return await callGatewayExternalMcpTool({ args, context, toolName });
  }

  if (!isSkillToolName(toolName)) {
    return null;
  }

  const startedAt = Date.now();
  let skill: ResolvedSkillTool | null;
  try {
    skill = await resolveSkillTool({ context, toolName });
  } catch (error) {
    // A load fault means we cannot tell whether the skill exists: answer with a
    // retryable error, never a definitive `unknown_tool`.
    const loadError = gatewayLoadErrorResult(error);
    if (loadError) {
      return loadError;
    }
    throw error;
  }
  if (!skill) {
    return structuredErrorResult({
      code: "unknown_tool",
      message: `Unknown tool: ${toolName}`,
      hint: "Call tools/list for the tools available to this session.",
    });
  }

  await recordSkillGatewayToolAudit({
    context,
    durationMs: Date.now() - startedAt,
    outcome: "success",
    skillId: skill.id,
    toolName,
  });

  return textResult({
    body: skill.body,
    compatibility: skill.compatibility,
    license: skill.license,
    metadata: skill.metadata,
    name: skill.slug,
    origin: skill.origin,
    version: skill.version,
  });
};
