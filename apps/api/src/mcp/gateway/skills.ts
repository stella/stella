import { Result } from "better-result";

import type { SkillResourceKind } from "@stll/skills/resource-kinds";

import type { SafeDbError } from "@/api/db/safe-db";
import {
  listAvailableChatSkillMetadata,
  loadAvailableChatSkill,
  readAvailableChatSkillResource,
  SKILL_RESOURCE_READ_STATUS,
} from "@/api/lib/agent-skills/skills";
import type {
  AvailableChatSkill,
  LoadedChatSkill,
} from "@/api/lib/agent-skills/skills";
import { captureError } from "@/api/lib/analytics/capture";
import {
  collisionSafeToolName,
  namespaceSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpRequestContext } from "@/api/mcp/context";
import { McpGatewayLoadError } from "@/api/mcp/errors";

/**
 * A skill as `tools/list` serves it: catalog metadata only. Instruction
 * bodies and resources are read for the one skill a call names.
 */
export type ResolvedSkillTool = AvailableChatSkill & {
  exposedName: string;
};

/**
 * The skill catalog is the one chat serves (enabled team skills plus the
 * caller's private ones, private first on a slug collision), so every agent
 * surface offers the same skills under the same precedence.
 */
export const loadVisibleSkillTools = async ({
  context,
}: {
  context: McpRequestContext;
}): Promise<ResolvedSkillTool[]> => {
  const skills = await listAvailableChatSkillMetadata({
    organizationId: context.organizationId,
    safeDb: context.safeDb,
    userId: context.userId,
  });

  if (Result.isError(skills)) {
    captureError(skills.error, { source: "mcp-gateway-skills" });
    // Propagate the load fault instead of `[]`, so a transient DB outage is not
    // mistaken for "no skills": dispatch maps this to a retryable error and
    // `tools/list` fails loudly rather than silently dropping skill tools.
    throw new McpGatewayLoadError({
      message: "Failed to load agent skills",
      cause: skills.error,
    });
  }

  return exposeSkillTools(skills.value);
};

export const resolveSkillTool = async ({
  context,
  toolName,
}: {
  context: McpRequestContext;
  toolName: string;
}): Promise<ResolvedSkillTool | null> =>
  (await loadVisibleSkillTools({ context })).find(
    (skill) => skill.exposedName === toolName,
  ) ?? null;

export const SKILL_TOOL_READ_TYPE = {
  resource: "resource",
  resourceNotFound: "resource-not-found",
  skill: "skill",
} as const;

export type SkillToolRead =
  | { type: typeof SKILL_TOOL_READ_TYPE.skill; skill: LoadedChatSkill }
  | {
      type: typeof SKILL_TOOL_READ_TYPE.resource;
      content: string;
      kind: SkillResourceKind;
      path: string;
      skill: ResolvedSkillTool;
    }
  | {
      type: typeof SKILL_TOOL_READ_TYPE.resourceNotFound;
      path: string;
      skill: ResolvedSkillTool;
    };

/**
 * Reads what one skill call asks for: the instructions and resource list of
 * the skill it resolved to, or one of its resource files. `null` means the
 * skill stopped being available between resolution and this read (deleted or
 * disabled).
 */
export const readSkillTool = async ({
  context,
  resourcePath,
  skill,
}: {
  context: McpRequestContext;
  resourcePath: string | undefined;
  skill: ResolvedSkillTool;
}): Promise<SkillToolRead | null> => {
  const scope = {
    organizationId: context.organizationId,
    safeDb: context.safeDb,
    skillName: skill.name,
    userId: context.userId,
  };

  if (resourcePath === undefined) {
    const loaded = throwOnLoadFault(await loadAvailableChatSkill(scope));
    return loaded === null
      ? null
      : { type: SKILL_TOOL_READ_TYPE.skill, skill: loaded };
  }

  const read = throwOnLoadFault(
    await readAvailableChatSkillResource({ ...scope, path: resourcePath }),
  );
  switch (read.status) {
    case SKILL_RESOURCE_READ_STATUS.skillNotFound:
      return null;
    case SKILL_RESOURCE_READ_STATUS.resourceNotFound:
      return {
        type: SKILL_TOOL_READ_TYPE.resourceNotFound,
        path: resourcePath,
        skill,
      };
    case SKILL_RESOURCE_READ_STATUS.found:
      return {
        type: SKILL_TOOL_READ_TYPE.resource,
        content: read.content,
        kind: read.kind,
        path: resourcePath,
        skill,
      };
    default:
      return read satisfies never;
  }
};

const throwOnLoadFault = <T>(result: Result<T, SafeDbError>): T => {
  if (Result.isError(result)) {
    captureError(result.error, { source: "mcp-gateway-skills" });
    // A load fault means the skill may still exist: dispatch answers a
    // retryable error rather than `unknown_tool`.
    throw new McpGatewayLoadError({
      message: "Failed to load agent skill",
      cause: result.error,
    });
  }
  return result.value;
};

/**
 * Pure naming step over an already precedence-resolved catalog, exported so
 * tests and the orientation eval derive collision-safe exposed names through
 * the served code path rather than a hand-written mirror of it.
 */
export const exposeSkillTools = (
  skills: readonly AvailableChatSkill[],
): ResolvedSkillTool[] => {
  const seenToolNames = new Set<string>();

  return skills.map((skill) => ({
    ...skill,
    exposedName: collisionSafeToolName({
      baseName: namespaceSkillToolName(skill.name),
      rawName: skill.name,
      seen: seenToolNames,
    }),
  }));
};
