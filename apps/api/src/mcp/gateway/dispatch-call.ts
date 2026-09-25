import type { CallToolResult } from "@modelcontextprotocol/server";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  SKILL_TOOL_INPUT,
  SKILL_TOOL_OUTPUT_TYPE,
} from "@/api/mcp/gateway/dynamic-tool-policy";
import type { SkillToolOutput } from "@/api/mcp/gateway/dynamic-tool-policy";
import {
  callGatewayExternalMcpTool,
  gatewayLoadErrorResult,
  recordSkillGatewayToolAudit,
} from "@/api/mcp/gateway/external-tools";
import {
  readSkillTool,
  resolveSkillTool,
  SKILL_TOOL_READ_TYPE,
} from "@/api/mcp/gateway/skills";
import type { SkillToolRead } from "@/api/mcp/gateway/skills";
import type { InternalToolResult } from "@/api/mcp/tool-types";
import {
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";

export type GatewayDispatchDependencies = {
  callGatewayExternalMcpTool: typeof callGatewayExternalMcpTool;
  gatewayLoadErrorResult: typeof gatewayLoadErrorResult;
  readSkillTool: typeof readSkillTool;
  recordSkillGatewayToolAudit: typeof recordSkillGatewayToolAudit;
  resolveSkillTool: typeof resolveSkillTool;
};

const defaultDependencies: GatewayDispatchDependencies = {
  callGatewayExternalMcpTool,
  gatewayLoadErrorResult,
  readSkillTool,
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

  const input = v.safeParse(SKILL_TOOL_INPUT.inputSchemaSource, args);
  if (!input.success) {
    return { type: "internal", result: validationErrorResult(input.issues) };
  }

  const startedAt = Temporal.Now.instant().epochMilliseconds;
  let read: SkillToolRead | null;
  try {
    const resolved = await dependencies.resolveSkillTool({
      context,
      toolName,
    });
    read =
      resolved === null
        ? null
        : await dependencies.readSkillTool({
            context,
            resourcePath: input.output.resource,
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
  if (read === null) {
    return { type: "internal", result: unknownToolResult(toolName) };
  }

  switch (read.type) {
    case SKILL_TOOL_READ_TYPE.resourceNotFound:
      return {
        type: "internal",
        result: structuredErrorResult({
          code: "not_found",
          message: `This skill has no resource file at ${read.path}.`,
          hint: `Call ${toolName} without \`resource\` to list the skill's resource paths.`,
        }),
      };
    case SKILL_TOOL_READ_TYPE.skill:
      await dependencies.recordSkillGatewayToolAudit({
        context,
        durationMs: Temporal.Now.instant().epochMilliseconds - startedAt,
        outcome: "success",
        skillId: read.skill.id,
        toolName,
      });
      // Bound to the family's shared output contract at compile time; dispatch
      // validates the served value against the same Valibot source at runtime.
      return {
        type: "internal",
        result: toolDataResult({
          type: SKILL_TOOL_OUTPUT_TYPE.skill,
          body: read.skill.body,
          compatibility: read.skill.compatibility,
          id: read.skill.id,
          license: read.skill.license,
          metadata: read.skill.metadata,
          name: read.skill.name,
          origin: read.skill.origin,
          resources: read.skill.resources,
          version: read.skill.version,
        } satisfies SkillToolOutput),
      };
    case SKILL_TOOL_READ_TYPE.resource:
      await dependencies.recordSkillGatewayToolAudit({
        context,
        durationMs: Temporal.Now.instant().epochMilliseconds - startedAt,
        outcome: "success",
        skillId: read.skill.id,
        toolName,
      });
      return {
        type: "internal",
        result: toolDataResult({
          type: SKILL_TOOL_OUTPUT_TYPE.resource,
          content: read.content,
          id: read.skill.id,
          kind: read.kind,
          name: read.skill.name,
          path: read.path,
        } satisfies SkillToolOutput),
      };
    default:
      return read satisfies never;
  }
};
