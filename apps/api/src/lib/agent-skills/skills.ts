import { Result } from "better-result";
import { and, asc, eq, or } from "drizzle-orm";

import { roles } from "@stll/permissions";
import type { SkillMetadata, SkillResource } from "@stll/skills";
import type { SkillResourceKind } from "@stll/skills/resource-kinds";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  agentSkillResources,
  agentSkills,
  type AgentSkillOrigin,
} from "@/api/db/schema";
import { canManageSkill } from "@/api/lib/agent-skills/access";
import { requireEditableSkillOrigin } from "@/api/lib/agent-skills/origin";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { isMemberRole } from "@/api/lib/member-roles";

export type AvailableChatSkill = SkillMetadata & {
  displayName: string;
  id: SafeId<"agentSkill">;
};

export const ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS = 30_000;

type ChatSkillContext = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

type ActiveChatSkillRequest = {
  skillId: SafeId<"agentSkill">;
  skillName: string;
};

type ChatMemberRole = {
  role: string;
};

export type ActiveChatSkillContext = {
  body: string;
  description: string;
  displayName: string;
  editable: boolean;
  id: SafeId<"agentSkill">;
  origin: AgentSkillOrigin;
  resources: SkillResource[];
  toolName: string;
  version: string | null;
};

export const resolveActiveChatSkillContext = async ({
  activeSkill,
  memberRole,
  organizationId,
  safeDb,
  userId,
}: ChatSkillContext & {
  activeSkill: ActiveChatSkillRequest | undefined;
  memberRole: ChatMemberRole;
}): Promise<
  Result<ActiveChatSkillContext | null, HandlerError<403 | 404> | SafeDbError>
> => {
  if (!activeSkill) {
    return Result.ok(null);
  }

  return await resolveInstalledActiveSkill({
    activeSkill,
    memberRole,
    organizationId,
    safeDb,
    userId,
  });
};

const resolveInstalledActiveSkill = async ({
  activeSkill,
  memberRole,
  organizationId,
  safeDb,
  userId,
}: ChatSkillContext & {
  activeSkill: ActiveChatSkillRequest;
  memberRole: ChatMemberRole;
}): Promise<
  Result<ActiveChatSkillContext, HandlerError<403 | 404> | SafeDbError>
> => {
  const skillRows = await safeDb((tx) =>
    tx
      .select({
        id: agentSkills.id,
        body: agentSkills.body,
        description: agentSkills.description,
        enabled: agentSkills.enabled,
        name: agentSkills.name,
        origin: agentSkills.origin,
        scope: agentSkills.scope,
        slug: agentSkills.slug,
        userId: agentSkills.userId,
        version: agentSkills.version,
      })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.id, activeSkill.skillId),
          eq(agentSkills.organizationId, organizationId),
        ),
      )
      .limit(1),
  );
  if (Result.isError(skillRows)) {
    return Result.err(skillRows.error);
  }

  const skill = skillRows.value.at(0);
  if (!skill) {
    return Result.err(
      new HandlerError({ status: 404, message: "Skill not found" }),
    );
  }

  if (skill.scope === "private" && skill.userId !== userId) {
    return Result.err(
      new HandlerError({ status: 404, message: "Skill not found" }),
    );
  }
  if (
    !canReadActiveSkillBody({
      enabled: skill.enabled,
      memberRole,
      origin: skill.origin,
      scope: skill.scope,
      skillUserId: skill.userId,
      userId,
    })
  ) {
    return Result.err(new HandlerError({ status: 403, message: "Forbidden" }));
  }

  const resources = await safeDb((tx) =>
    tx
      .select({
        kind: agentSkillResources.kind,
        path: agentSkillResources.path,
      })
      .from(agentSkillResources)
      .where(eq(agentSkillResources.skillId, skill.id))
      .orderBy(asc(agentSkillResources.path))
      .limit(LIMITS.agentSkillResourcesPerSkill),
  );
  if (Result.isError(resources)) {
    return Result.err(resources.error);
  }

  return Result.ok({
    body: skill.body,
    description: skill.description,
    displayName: skill.name,
    editable: canEditActiveSkill({
      memberRole,
      origin: skill.origin,
      scope: skill.scope,
      skillUserId: skill.userId,
      userId,
    }),
    id: skill.id,
    origin: skill.origin,
    resources: resources.value,
    toolName: skill.slug,
    version: skill.version,
  });
};

export const canEditActiveSkill = ({
  memberRole,
  origin,
  scope,
  skillUserId,
  userId,
}: {
  memberRole: ChatMemberRole;
  origin: AgentSkillOrigin;
  scope: "private" | "team";
  skillUserId: string;
  userId: SafeId<"user">;
}): boolean => {
  if (
    !isMemberRole(memberRole.role) ||
    !roles[memberRole.role].authorize({ agentSkill: ["update"] }).success
  ) {
    return false;
  }

  if (
    !canManageSkill({
      memberRole,
      skill: { scope, userId: skillUserId },
      userId,
    })
  ) {
    return false;
  }

  return !Result.isError(requireEditableSkillOrigin(origin));
};

const canReadActiveSkillBody = ({
  enabled,
  memberRole,
  origin,
  scope,
  skillUserId,
  userId,
}: {
  enabled: boolean;
  memberRole: ChatMemberRole;
  origin: AgentSkillOrigin;
  scope: "private" | "team";
  skillUserId: string;
  userId: SafeId<"user">;
}): boolean => {
  if (scope === "private") {
    return skillUserId === userId;
  }

  if (enabled) {
    return true;
  }

  return canEditActiveSkill({
    memberRole,
    origin,
    scope,
    skillUserId,
    userId,
  });
};

export const listAvailableChatSkillMetadata = async ({
  organizationId,
  safeDb,
  userId,
}: ChatSkillContext): Promise<Result<AvailableChatSkill[], SafeDbError>> => {
  const rows = await safeDb((tx) =>
    tx
      .select({
        id: agentSkills.id,
        scope: agentSkills.scope,
        name: agentSkills.name,
        slug: agentSkills.slug,
        description: agentSkills.description,
        version: agentSkills.version,
        license: agentSkills.license,
        compatibility: agentSkills.compatibility,
        metadata: agentSkills.metadata,
      })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.organizationId, organizationId),
          eq(agentSkills.enabled, true),
          or(eq(agentSkills.scope, "team"), eq(agentSkills.userId, userId)),
        ),
      )
      .orderBy(agentSkills.scope, agentSkills.slug, agentSkills.id)
      .limit(LIMITS.agentSkillsChatMetadataMax),
  );

  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }

  return Result.ok(resolveSkillPrecedence(rows.value));
};

/** A skill the caller can load right now, with the row it came from. */
export type LoadedChatSkill = {
  body: string;
  compatibility: string | null;
  description: string;
  id: SafeId<"agentSkill">;
  license: string | null;
  metadata: Record<string, string>;
  /** The skill slug: the name the catalog and the skill tools use. */
  name: string;
  origin: AgentSkillOrigin;
  resources: { kind: SkillResourceKind; path: string }[];
  version: string | null;
};

/**
 * Resolves `skillName` against the caller's skills when the tool runs, not
 * when the catalog was built. `null` means the skill is no longer available
 * (deleted, disabled, or renamed since), which callers report as not found.
 */
export const loadAvailableChatSkill = async ({
  activeSkillId,
  organizationId,
  safeDb,
  skillName,
  userId,
}: ChatSkillContext & {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  skillName: string;
}): Promise<Result<LoadedChatSkill | null, SafeDbError>> => {
  const rowResult = await findInstalledSkill({
    activeSkillId,
    organizationId,
    safeDb,
    skillName,
    userId,
  });
  if (Result.isError(rowResult)) {
    return Result.err(rowResult.error);
  }

  const row = rowResult.value;
  if (!row) {
    return Result.ok(null);
  }

  const resources = await safeDb((tx) =>
    tx
      .select({
        kind: agentSkillResources.kind,
        path: agentSkillResources.path,
      })
      .from(agentSkillResources)
      .where(eq(agentSkillResources.skillId, row.id))
      .orderBy(agentSkillResources.path)
      .limit(LIMITS.agentSkillResourcesPerSkill),
  );
  if (Result.isError(resources)) {
    return Result.err(resources.error);
  }

  return Result.ok({
    body: row.body,
    compatibility: row.compatibility,
    description: row.description,
    id: row.id,
    license: row.license,
    metadata: row.metadata,
    name: row.slug,
    origin: row.origin,
    resources: resources.value,
    version: row.version,
  });
};

export const SKILL_RESOURCE_READ_STATUS = {
  found: "found",
  resourceNotFound: "resource-not-found",
  skillNotFound: "skill-not-found",
} as const;

export type AvailableChatSkillResourceRead =
  | {
      status: typeof SKILL_RESOURCE_READ_STATUS.found;
      content: string;
      kind: SkillResourceKind;
      origin: AgentSkillOrigin;
      skillId: SafeId<"agentSkill">;
    }
  | {
      status: typeof SKILL_RESOURCE_READ_STATUS.resourceNotFound;
      skillId: SafeId<"agentSkill">;
    }
  | { status: typeof SKILL_RESOURCE_READ_STATUS.skillNotFound };

export const readAvailableChatSkillResource = async ({
  activeSkillId,
  organizationId,
  path,
  safeDb,
  skillName,
  userId,
}: ChatSkillContext & {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  path: string;
  skillName: string;
}): Promise<Result<AvailableChatSkillResourceRead, SafeDbError>> => {
  const rowResult = await findInstalledSkill({
    activeSkillId,
    organizationId,
    safeDb,
    skillName,
    userId,
  });
  if (Result.isError(rowResult)) {
    return Result.err(rowResult.error);
  }

  const row = rowResult.value;
  if (!row) {
    return Result.ok({ status: SKILL_RESOURCE_READ_STATUS.skillNotFound });
  }

  const resources = await safeDb((tx) =>
    tx
      .select({
        content: agentSkillResources.content,
        kind: agentSkillResources.kind,
      })
      .from(agentSkillResources)
      .where(
        and(
          eq(agentSkillResources.skillId, row.id),
          eq(agentSkillResources.path, path),
        ),
      )
      .limit(1),
  );
  if (Result.isError(resources)) {
    return Result.err(resources.error);
  }

  const resource = resources.value.at(0);
  if (!resource) {
    return Result.ok({
      status: SKILL_RESOURCE_READ_STATUS.resourceNotFound,
      skillId: row.id,
    });
  }

  return Result.ok({
    status: SKILL_RESOURCE_READ_STATUS.found,
    content: resource.content,
    kind: resource.kind,
    origin: row.origin,
    skillId: row.id,
  });
};

const findInstalledSkill = async ({
  activeSkillId,
  organizationId,
  safeDb,
  skillName,
  userId,
}: ChatSkillContext & {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  skillName: string;
}) => {
  const enabledOrActive =
    activeSkillId === undefined
      ? eq(agentSkills.enabled, true)
      : or(eq(agentSkills.enabled, true), eq(agentSkills.id, activeSkillId));

  const rows = await safeDb((tx) =>
    tx
      .select({
        id: agentSkills.id,
        scope: agentSkills.scope,
        slug: agentSkills.slug,
        description: agentSkills.description,
        version: agentSkills.version,
        license: agentSkills.license,
        compatibility: agentSkills.compatibility,
        metadata: agentSkills.metadata,
        body: agentSkills.body,
        origin: agentSkills.origin,
      })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.organizationId, organizationId),
          enabledOrActive,
          eq(agentSkills.slug, skillName),
          or(eq(agentSkills.scope, "team"), eq(agentSkills.userId, userId)),
        ),
      )
      .limit(LIMITS.agentSkillsPerUser),
  );
  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }

  return Result.ok(
    rows.value
      .toSorted(
        (a, b) =>
          activeSkillPriority(a.id, activeSkillId) -
            activeSkillPriority(b.id, activeSkillId) ||
          scopePriority(a.scope) - scopePriority(b.scope) ||
          // oxlint-disable-next-line require-cached-collator/require-cached-collator -- id tiebreak for deterministic ordering, not display text
          a.id.localeCompare(b.id),
      )
      .at(0) ?? null,
  );
};

type InstalledSkillMetadataRow = {
  compatibility: string | null;
  description: string;
  id: SafeId<"agentSkill">;
  license: string | null;
  metadata: Record<string, string>;
  name: string;
  scope: "team" | "private";
  slug: string;
  version: string | null;
};

const resolveSkillPrecedence = (
  installedRows: readonly InstalledSkillMetadataRow[],
): AvailableChatSkill[] => {
  const skills: AvailableChatSkill[] = [];
  const seen = new Set<string>();

  for (const row of installedRows.toSorted(
    (a, b) => scopePriority(a.scope) - scopePriority(b.scope),
  )) {
    if (seen.has(row.slug)) {
      continue;
    }
    seen.add(row.slug);
    skills.push({
      compatibility: row.compatibility,
      description: row.description,
      displayName: row.name,
      id: row.id,
      license: row.license,
      metadata: row.metadata,
      name: row.slug,
      version: row.version,
    });
  }

  // oxlint-disable-next-line require-cached-collator/require-cached-collator -- `name` here is the skill slug (machine identifier); `displayName` carries the user-facing text
  return skills.toSorted((a, b) => a.name.localeCompare(b.name));
};

const scopePriority = (scope: "team" | "private") =>
  scope === "private" ? 0 : 1;

const activeSkillPriority = (
  skillId: SafeId<"agentSkill">,
  activeSkillId: SafeId<"agentSkill"> | undefined,
) => (skillId === activeSkillId ? 0 : 1);
