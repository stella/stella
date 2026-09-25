import type { CallToolResult } from "@modelcontextprotocol/server";

import { Temporal } from "@stll/time";

import type { LoadedChatSkill } from "@/api/lib/agent-skills/skills";
import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import type { SkillToolOutput } from "@/api/mcp/gateway/dynamic-tool-policy";
import {
  callGatewayExternalMcpTool,
  gatewayLoadErrorResult,
  recordSkillGatewayToolAudit,
} from "@/api/mcp/gateway/external-tools";
import {
  loadSkillToolContent,
  resolveSkillTool,
} from "@/api/mcp/gateway/skills";
import type { InternalToolResult } from "@/api/mcp/tool-types";
import { structuredErrorResult, toolDataResult } from "@/api/mcp/tool-utils";

export type GatewayDispatchDependencies = {
  callGatewayExternalMcpTool: typeof callGatewayExternalMcpTool;
  gatewayLoadErrorResult: typeof gatewayLoadErrorResult;
  loadSkillToolContent: typeof loadSkillToolContent;
  recordSkillGatewayToolAudit: typeof recordSkillGatewayToolAudit;
  resolveSkillTool: typeof resolveSkillTool;
};

const defaultDependencies: GatewayDispatchDependencies = {
  callGatewayExternalMcpTool,
  gatewayLoadErrorResult,
  loadSkillToolContent,
  recordSkillGatewayToolAudit,
  resolveSkillTool,
};

const unknownToolResult = (toolName: string) =>
  structuredErrorResult({
    code: "unknown_tool",
    message: `Unknown tool: ${toolName}`,
    hint: "Call tools/list for the tools available to this session.",
  });

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

  const startedAt = Temporal.Now.instant().epochMilliseconds;
  let skill: LoadedChatSkill | null;
  try {
    const resolved = await dependencies.resolveSkillTool({
      context,
      toolName,
    });
    skill =
      resolved === null
        ? null
        : await dependencies.loadSkillToolContent({
            context,
            skill: resolved,
          });
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
    return { type: "internal", result: unknownToolResult(toolName) };
  }

  await dependencies.recordSkillGatewayToolAudit({
    context,
    durationMs: Temporal.Now.instant().epochMilliseconds - startedAt,
    outcome: "success",
    skillId: skill.id,
    toolName,
  });

  // Bound to the family's shared output contract at compile time; dispatch
  // validates the served value against the same Valibot source at runtime.
  return {
    type: "internal",
    result: toolDataResult({
      body: skill.body,
      compatibility: skill.compatibility,
      license: skill.license,
      metadata: skill.metadata,
      name: skill.name,
      origin: skill.origin,
      version: skill.version,
    } satisfies SkillToolOutput),
  };
};
