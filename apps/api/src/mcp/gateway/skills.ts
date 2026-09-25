import { Result } from "better-result";

import {
  listAvailableChatSkillMetadata,
  loadAvailableChatSkill,
} from "@/api/lib/agent-skills/skills";
import type {
  AvailableChatSkill,
  LoadedChatSkill,
} from "@/api/lib/agent-skills/skills";
import { captureError } from "@/api/lib/analytics/capture";
import { LIMITS } from "@/api/lib/limits";
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

/**
 * Reads the instructions and resource list of the one skill a call resolved
 * to. `null` means the skill stopped being available between resolution and
 * this read (deleted or disabled).
 */
export const loadSkillToolContent = async ({
  context,
  skill,
}: {
  context: McpRequestContext;
  skill: ResolvedSkillTool;
}): Promise<LoadedChatSkill | null> => {
  const loaded = await loadAvailableChatSkill({
    organizationId: context.organizationId,
    safeDb: context.safeDb,
    skillName: skill.name,
    userId: context.userId,
  });

  if (Result.isError(loaded)) {
    captureError(loaded.error, { source: "mcp-gateway-skills" });
    throw new McpGatewayLoadError({
      message: "Failed to load agent skill",
      cause: loaded.error,
    });
  }

  return loaded.value;
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

  return skills.slice(0, LIMITS.mcpGatewaySkillsMax).map((skill) => ({
    ...skill,
    exposedName: collisionSafeToolName({
      baseName: namespaceSkillToolName(skill.name),
      rawName: skill.name,
      seen: seenToolNames,
    }),
  }));
};
