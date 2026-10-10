import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic } from "better-result";
import * as v from "valibot";

import {
  describeMissingSkillTools,
  SKILL_TOOL_AVAILABILITY_STATUS,
} from "@/api/lib/agent-skills/required-tools";
import {
  recordSkillReadAudit,
  SKILL_READ_OUTCOME,
  SKILL_READ_SURFACE,
} from "@/api/lib/agent-skills/skill-read-audit";
import type { SkillReadOutcome } from "@/api/lib/agent-skills/skill-read-audit";
import { chatSkillId, chatSkillOrigin } from "@/api/lib/agent-skills/skills";
import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import { projectionPayload } from "@/api/lib/projection-totality";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  SKILL_TOOL_INPUT,
  SKILL_TOOL_OUTPUT,
  SKILL_TOOL_OUTPUT_TYPE,
} from "@/api/mcp/gateway/dynamic-tool-policy";
import type { SkillToolOutput } from "@/api/mcp/gateway/dynamic-tool-policy";
import {
  callGatewayExternalMcpTool,
  gatewayLoadErrorResult,
} from "@/api/mcp/gateway/external-tools";
import {
  GATEWAY_TOOL_KIND,
  modeAllowsGatewayTools,
} from "@/api/mcp/gateway/mode-policy";
import {
  readSkillTool,
  resolveSkillTool,
  SKILL_TOOL_READ_TYPE,
} from "@/api/mcp/gateway/skills";
import type {
  ResolvedSkillTool,
  SkillToolRead,
} from "@/api/mcp/gateway/skills";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import type {
  InternalToolErrorResult,
  InternalToolResult,
} from "@/api/mcp/tool-types";
import {
  oauthScopeRecoveryHint,
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

/**
 * A skill this session does not list because it lacks a tool the skill
 * requires. The instructions are not served: a client that ran them would
 * reach a step it cannot take. When a missing scope is the reason, the hint
 * is the OAuth recovery; otherwise the skill needs the stella app.
 */
const unavailableSkillResult = ({
  grantedScopes,
  missingTools,
  skillName,
}: {
  grantedScopes: readonly string[];
  missingTools: readonly string[];
  skillName: string;
}): InternalToolErrorResult => {
  const message = `The skill "${skillName}" cannot run in this session. ${describeMissingSkillTools(missingTools)}`;
  const missingScopes = [
    ...new Set(
      missingTools.flatMap((name) => {
        const definition = getStaticMcpToolDefinition(name);
        if (definition === undefined) {
          return [];
        }
        const { additionalScopes = [], scope } = definition;
        return [scope, ...additionalScopes].filter(
          (required) => !grantedScopes.includes(required),
        );
      }),
    ),
  ];
  const missingScope = missingScopes.at(0);
  if (missingScope !== undefined) {
    return structuredErrorResult({
      code: "missing_scope",
      message,
      hint: oauthScopeRecoveryHint({
        grantedScopes,
        missingScope,
        requiredScopes: [...missingScopes, "stella:skills"],
      }),
    });
  }
  return structuredErrorResult({
    code: "feature_disabled",
    message,
    hint: "Run this skill from a stella chat that offers those tools, or continue the task without it.",
  });
};

export type GatewayDispatchResult =
  | { type: "external_mcp"; result: CallToolResult }
  | { type: "internal"; result: InternalToolResult<SkillToolOutput> };

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
  if (isExternalMcpToolName(toolName)) {
    if (!modeAllowsGatewayTools(mode, GATEWAY_TOOL_KIND.externalMcp)) {
      return null;
    }
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
  if (!modeAllowsGatewayTools(mode, GATEWAY_TOOL_KIND.skill)) {
    return null;
  }

  const input = v.safeParse(SKILL_TOOL_INPUT.inputSchemaSource, args);
  if (!input.success) {
    return { type: "internal", result: validationErrorResult(input.issues) };
  }

  let resolved: ResolvedSkillTool | null;
  try {
    resolved = await dependencies.resolveSkillTool({ context, mode, toolName });
  } catch (error) {
    return loadFaultResult({ dependencies, error });
  }
  if (resolved === null) {
    return { type: "internal", result: unknownToolResult(toolName) };
  }
  if (
    resolved.availability.status === SKILL_TOOL_AVAILABILITY_STATUS.unavailable
  ) {
    return {
      type: "internal",
      result: unavailableSkillResult({
        grantedScopes: context.grantedScopes,
        missingTools: resolved.availability.missingTools,
        skillName: resolved.name,
      }),
    };
  }

  const skill = resolved;
  const resourcePath = input.output.resource ?? null;
  const auditRead = async (outcome: SkillReadOutcome) =>
    await dependencies.recordSkillReadAudit({
      reads: [
        {
          outcome,
          path: resourcePath,
          skill,
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
        result: toolDataResult(
          projectionPayload(SKILL_TOOL_OUTPUT.outputSchemaSource, {
            type: SKILL_TOOL_OUTPUT_TYPE.skill,
            body: read.skill.body,
            compatibility: read.skill.compatibility,
            id: chatSkillId(read.skill),
            license: read.skill.license,
            metadata: read.skill.metadata,
            name: read.skill.name,
            origin: chatSkillOrigin(read.skill),
            resources: read.skill.resources,
            version: read.skill.version,
          }),
        ),
      };
    case SKILL_TOOL_READ_TYPE.resource:
      await auditRead(SKILL_READ_OUTCOME.success);
      return {
        type: "internal",
        result: toolDataResult(
          projectionPayload(SKILL_TOOL_OUTPUT.outputSchemaSource, {
            type: SKILL_TOOL_OUTPUT_TYPE.resource,
            content: read.content,
            id: chatSkillId(read.skill),
            kind: read.kind,
            name: read.skill.name,
            path: read.path,
          }),
        ),
      };
    default: {
      read satisfies never;
      return panic("skill tool read returned an unknown type");
    }
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
