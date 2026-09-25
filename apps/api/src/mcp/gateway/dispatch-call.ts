import type { CallToolResult } from "@modelcontextprotocol/server";
import * as v from "valibot";

import {
  recordSkillReadAudit,
  SKILL_READ_OUTCOME,
  SKILL_READ_SURFACE,
} from "@/api/lib/agent-skills/skill-read-audit";
import type { SkillReadOutcome } from "@/api/lib/agent-skills/skill-read-audit";
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
} from "@/api/mcp/gateway/external-tools";
import {
  readSkillTool,
  resolveSkillTool,
  SKILL_TOOL_READ_TYPE,
} from "@/api/mcp/gateway/skills";
import type {
  ResolvedSkillTool,
  SkillToolRead,
} from "@/api/mcp/gateway/skills";
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
  recordSkillReadAudit: typeof recordSkillReadAudit;
  resolveSkillTool: typeof resolveSkillTool;
};

const defaultDependencies: GatewayDispatchDependencies = {
  callGatewayExternalMcpTool,
  gatewayLoadErrorResult,
  readSkillTool,
  recordSkillReadAudit,
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

  let resolved: ResolvedSkillTool | null;
  try {
    resolved = await dependencies.resolveSkillTool({ context, toolName });
  } catch (error) {
    return loadFaultResult({ dependencies, error });
  }
  if (resolved === null) {
    return { type: "internal", result: unknownToolResult(toolName) };
  }

  const skill = resolved;
  const resourcePath = input.output.resource ?? null;
  const auditRead = async (outcome: SkillReadOutcome) =>
    await dependencies.recordSkillReadAudit({
      reads: [
        {
          outcome,
          path: resourcePath,
          skillId: skill.id,
          slug: skill.name,
          surface: SKILL_READ_SURFACE.mcp,
        },
      ],
      recordAuditEvent: context.recordAuditEvent,
      safeDb: context.safeDb,
    });

  let read: SkillToolRead | null;
  try {
    read = await dependencies.readSkillTool({
      context,
      resourcePath: input.output.resource,
      skill,
    });
  } catch (error) {
    await auditRead(SKILL_READ_OUTCOME.error);
    return loadFaultResult({ dependencies, error });
  }
  if (read === null) {
    // Disabled or deleted between resolution and this read.
    await auditRead(SKILL_READ_OUTCOME.error);
    return { type: "internal", result: unknownToolResult(toolName) };
  }

  switch (read.type) {
    case SKILL_TOOL_READ_TYPE.resourceNotFound:
      await auditRead(SKILL_READ_OUTCOME.error);
      return {
        type: "internal",
        result: structuredErrorResult({
          code: "not_found",
          message: `This skill has no resource file at ${read.path}.`,
          hint: `Call ${toolName} without \`resource\` to list the skill's resource paths.`,
        }),
      };
    case SKILL_TOOL_READ_TYPE.skill:
      await auditRead(SKILL_READ_OUTCOME.success);
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
      await auditRead(SKILL_READ_OUTCOME.success);
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

/**
 * A load fault means we cannot tell whether the skill exists: answer with a
 * retryable error, never a definitive `unknown_tool`.
 */
const loadFaultResult = ({
  dependencies,
  error,
}: {
  dependencies: GatewayDispatchDependencies;
  error: unknown;
}): GatewayDispatchResult => {
  const loadError = dependencies.gatewayLoadErrorResult(error);
  if (loadError) {
    return { type: "internal", result: loadError };
  }
  throw error;
};
