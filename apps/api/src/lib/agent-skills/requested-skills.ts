import { Result } from "better-result";

import type { SkillMetadata } from "@stll/skills";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  recordSkillReadAudit,
  SKILL_READ_OUTCOME,
  SKILL_READ_SURFACE,
} from "@/api/lib/agent-skills/skill-read-audit";
import { extractSkillRefSlugs } from "@/api/lib/agent-skills/skill-refs";
import { loadAvailableChatSkills } from "@/api/lib/agent-skills/skills";
import type { LoadedChatSkill } from "@/api/lib/agent-skills/skills";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Skills one message can have preloaded. Each preloaded body rides in the
 * system prompt, so the bound keeps a message that references many skills
 * from crowding out the conversation; the rest stay loadable by `load-skill`.
 */
const REQUESTED_SKILLS_PRELOAD_MAX = 3;

export type RequestedSkills = {
  /** Referenced, available, and loaded for this turn. */
  loaded: LoadedChatSkill[];
  /** Referenced and available, but past the preload bound. */
  notPreloaded: string[];
  /** Referenced but not available to the caller. */
  unavailable: string[];
};

export type ResolveRequestedSkillsOptions = {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  /** The skills the caller may use in this turn (the chat catalog). */
  catalog: readonly SkillMetadata[];
  messageText: string;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

/**
 * Resolves the skills a user message references explicitly
 * (`[label](#stella-skill-ref=slug)`) through the same load path as
 * `load-skill`, audit included, so an explicit pick does not depend on the
 * model choosing to load it.
 */
export const resolveRequestedSkills = async ({
  activeSkillId,
  catalog,
  messageText,
  organizationId,
  recordAuditEvent,
  safeDb,
  userId,
}: ResolveRequestedSkillsOptions): Promise<
  Result<RequestedSkills, SafeDbError>
> => {
  const available = new Set(catalog.map((skill) => skill.name));
  const referenced = extractSkillRefSlugs(messageText);
  const availableSlugs = referenced.filter((slug) => available.has(slug));
  const toLoad = availableSlugs.slice(0, REQUESTED_SKILLS_PRELOAD_MAX);
  const unavailable = referenced.filter((slug) => !available.has(slug));

  const loadResult = await loadAvailableChatSkills({
    activeSkillId,
    organizationId,
    safeDb,
    skillNames: toLoad,
    userId,
  });
  if (Result.isError(loadResult)) {
    return Result.err(loadResult.error);
  }

  const loaded: LoadedChatSkill[] = [];
  for (const skillName of toLoad) {
    const skill = loadResult.value.get(skillName);
    if (skill === undefined) {
      // Disabled or deleted after the catalog was read.
      unavailable.push(skillName);
      continue;
    }
    loaded.push(skill);
  }

  if (loaded.length > 0) {
    await recordSkillReadAudit({
      reads: loaded.map((skill) => ({
        outcome: SKILL_READ_OUTCOME.success,
        path: null,
        skillId: skill.id,
        slug: skill.name,
        surface: SKILL_READ_SURFACE.chat,
      })),
      recordAuditEvent,
      safeDb,
    });
  }

  return Result.ok({
    loaded,
    notPreloaded: availableSlugs.slice(REQUESTED_SKILLS_PRELOAD_MAX),
    unavailable,
  });
};
