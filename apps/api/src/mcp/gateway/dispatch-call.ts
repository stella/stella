import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  callGatewayExternalMcpTool,
  recordSkillGatewayToolAudit,
} from "@/api/mcp/gateway/external-tools";
import { resolveSkillTool } from "@/api/mcp/gateway/skills";
import { errorResult, textResult } from "@/api/mcp/tool-utils";

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
  const skill = await resolveSkillTool({ context, toolName });
  if (!skill) {
    return errorResult(`Unknown tool: ${toolName}`);
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
