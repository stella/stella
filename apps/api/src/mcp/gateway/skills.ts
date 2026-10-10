import { panic, Result } from "better-result";

import type { SkillResourceKind } from "@stll/skills/format";

import type { SafeDbError } from "@/api/db/safe-db";
import {
  anySkillRequiresTools,
  resolveSkillToolAvailability,
  SKILL_TOOL_AVAILABILITY_STATUS,
} from "@/api/lib/agent-skills/required-tools";
import type { SkillToolAvailability } from "@/api/lib/agent-skills/required-tools";
import {
  CHAT_SKILL_SOURCE,
  listAvailableChatSkillMetadata,
  loadAvailableChatSkill,
  readAvailableChatSkillResource,
  SKILL_RESOURCE_READ_STATUS,
} from "@/api/lib/agent-skills/skills";
import type {
  AvailableChatSkill,
  ChatSkillRef,
  LoadedChatSkill,
} from "@/api/lib/agent-skills/skills";
import { captureError } from "@/api/lib/analytics/capture";
import {
  collisionSafeToolName,
  namespaceSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { McpGatewayLoadError } from "@/api/mcp/errors";
import {
  hasGrantedScope,
  listOfferedStaticMcpToolDefinitions,
} from "@/api/mcp/gateway/static-tool-visibility";

const AVAILABLE: SkillToolAvailability = {
  status: SKILL_TOOL_AVAILABILITY_STATUS.available,
};

/**
 * A skill as `tools/list` serves it: catalog metadata only. Instruction
 * bodies and resources are read for the one skill a call names.
 */
export type ResolvedSkillTool = AvailableChatSkill & {
  /** Whether this session offers every tool the skill requires. */
  availability: SkillToolAvailability;
  exposedName: string;
};

/**
 * The skill catalog is the one chat serves (enabled team skills plus the
 * caller's private ones, private first on a slug collision), so every agent
 * surface offers the same skills under the same precedence. Exposed names are
 * assigned over the whole catalog, so hiding an unavailable skill never
 * renames another one.
 */
const loadSkillTools = async ({
  context,
  mode,
  scopes,
}: {
  context: McpRequestContext;
  mode: McpMode;
  scopes: readonly string[] | undefined;
}): Promise<ResolvedSkillTool[]> => {
  // A load fault propagates instead of `[]`, so a transient DB outage is not
  // mistaken for "no skills": dispatch maps it to a retryable error and
  // `tools/list` fails loudly rather than silently dropping skill tools.
  const skills = throwOnLoadFault(
    await listAvailableChatSkillMetadata({
      organizationId: context.organizationId,
      safeDb: context.safeDb,
      userId: context.userId,
    }),
  );
  const exposed = exposeSkillTools(skills);
  if (!anySkillRequiresTools(skills)) {
    return exposed.map((skill) =>
      Object.assign(skill, { availability: AVAILABLE }),
    );
  }

  // `tools/list` keeps a compound tool discoverable on its primary scope
  // alone; a skill can use it only with every scope it needs.
  const offeredToolNames = new Set(
    listOfferedStaticMcpToolDefinitions({
      context,
      mode,
      scopes,
      audience: "model",
    }).flatMap(({ additionalScopes = [], name }) =>
      additionalScopes.every((scope) => hasGrantedScope(scopes, scope))
        ? [name]
        : [],
    ),
  );
  return exposed.map((skill) =>
    Object.assign(skill, {
      availability: resolveSkillToolAvailability({
        metadata: skill.metadata,
        offeredToolNames,
      }),
    }),
  );
};

/**
 * The skills this session is offered: a skill whose required tools the
 * session does not list is left out, so a client cannot start a skill it
 * cannot finish. `scopes` are the session's granted scopes (`undefined`
 * grants all, as for `tools/list` without a scope filter).
 */
export const loadVisibleSkillTools = async ({
  context,
  mode,
  scopes,
}: {
  context: McpRequestContext;
  mode: McpMode;
  scopes?: readonly string[] | undefined;
}): Promise<ResolvedSkillTool[]> =>
  (await loadSkillTools({ context, mode, scopes })).filter(
    ({ availability }) =>
      availability.status === SKILL_TOOL_AVAILABILITY_STATUS.available,
  );

/**
 * Resolves a called skill by its exposed name, unavailable ones included, so
 * a call naming a hidden skill is refused with the reason rather than as an
 * unknown tool.
 */
export const resolveSkillTool = async ({
  context,
  mode,
  toolName,
}: {
  context: McpRequestContext;
  mode: McpMode;
  toolName: string;
}): Promise<ResolvedSkillTool | null> =>
  (await loadSkillTools({ context, mode, scopes: context.grantedScopes })).find(
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
 * disabled). The read re-resolves by slug, so a row other than the resolved
 * one (a team skill behind a private one disabled since) also counts as gone:
 * the caller audits the resolved row, and what it serves must come from it.
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
    return loaded === null || !isResolvedSkill({ read: loaded, skill })
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
      return isResolvedSkill({ read: read.skill, skill })
        ? {
            type: SKILL_TOOL_READ_TYPE.resourceNotFound,
            path: resourcePath,
            skill,
          }
        : null;
    case SKILL_RESOURCE_READ_STATUS.found:
      return isResolvedSkill({ read: read.skill, skill })
        ? {
            type: SKILL_TOOL_READ_TYPE.resource,
            content: read.content,
            kind: read.kind,
            path: resourcePath,
            skill,
          }
        : null;
    default: {
      read satisfies never;
      return panic("skill resource read returned an unknown status");
    }
  }
};

/**
 * Whether a read came from the skill the call resolved to: the same row for an
 * installed skill; for a built-in, no row having appeared for its slug since.
 */
const isResolvedSkill = ({
  read,
  skill,
}: {
  read: ChatSkillRef;
  skill: ResolvedSkillTool;
}): boolean => {
  switch (skill.source) {
    case CHAT_SKILL_SOURCE.installed:
      return (
        read.source === CHAT_SKILL_SOURCE.installed && read.id === skill.id
      );
    case CHAT_SKILL_SOURCE.builtIn:
      return read.source === CHAT_SKILL_SOURCE.builtIn;
    default: {
      skill satisfies never;
      return panic("skill tool has an unknown source");
    }
  }
};

const throwOnLoadFault = <T>(result: Result<T, SafeDbError>): T => {
  if (Result.isError(result)) {
    captureError(result.error, { source: "mcp-gateway-skills" });
    // A load fault means the skills may still exist: dispatch answers a
    // retryable error rather than `unknown_tool`.
    throw new McpGatewayLoadError({
      message: "Failed to load agent skills",
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
): (AvailableChatSkill & { exposedName: string })[] => {
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
