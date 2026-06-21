import { Result } from "better-result";
import { and, asc, eq, or } from "drizzle-orm";

import { roles } from "@stll/permissions";
import {
  listSkillMetadata,
  listSkillResources,
  loadSkill,
  readSkillResource,
} from "@stll/skills";
import type { SkillMetadata, SkillResource, StellaSkill } from "@stll/skills";

import type { SafeDb, SafeDbError } from "@/api/db";
import {
  agentSkillResources,
  agentSkills,
  type AgentSkillOrigin,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { isMemberRole } from "@/api/lib/member-roles";

import { requireEditableSkillOrigin } from "../skills/origin";

type AvailableChatSkill = SkillMetadata & {
  displayName?: string | undefined;
  id: string;
  source: "built-in" | "installed";
};

export const ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS = 30_000;

type ChatSkillContext = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

let chatSkillMetadata: SkillMetadata[] | undefined;

export const getChatSkillMetadata = (): SkillMetadata[] => {
  chatSkillMetadata ??= listSkillMetadata();
  return chatSkillMetadata;
};

type ActiveChatSkillRequest = {
  skillId?: SafeId<"agentSkill"> | undefined;
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
  id: SafeId<"agentSkill"> | null;
  origin: AgentSkillOrigin | "built-in";
  resources: SkillResource[];
  source: "built-in" | "installed";
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

  const activeSkillId = activeSkill.skillId;
  if (activeSkillId) {
    return await resolveInstalledActiveSkill({
      activeSkill: { ...activeSkill, skillId: activeSkillId },
      memberRole,
      organizationId,
      safeDb,
      userId,
    });
  }

  const metadata = getChatSkillMetadata().find(
    (skill) => skill.name === activeSkill.skillName,
  );
  if (!metadata) {
    return Result.err(
      new HandlerError({ status: 404, message: "Skill not found" }),
    );
  }

  const skill = loadSkill(metadata.name);
  return Result.ok({
    body: skill.body,
    description: skill.description,
    displayName: skill.name,
    editable: false,
    id: null,
    origin: "built-in",
    resources: skill.resources,
    source: "built-in",
    toolName: skill.name,
    version: skill.version,
  });
};

const resolveInstalledActiveSkill = async ({
  activeSkill,
  memberRole,
  organizationId,
  safeDb,
  userId,
}: ChatSkillContext & {
  activeSkill: ActiveChatSkillRequest & { skillId: SafeId<"agentSkill"> };
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
    source: "installed",
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

  if (scope === "team" && !["admin", "owner"].includes(memberRole.role)) {
    return false;
  }
  if (scope === "private" && skillUserId !== userId) {
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

export const loadAvailableChatSkill = async ({
  activeSkillId,
  organizationId,
  safeDb,
  skillName,
  userId,
}: ChatSkillContext & {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  skillName: string;
}): Promise<Result<StellaSkill, SafeDbError>> => {
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
    return Result.ok(loadSkill(skillName));
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
    compatibility: row.compatibility,
    description: row.description,
    license: row.license,
    metadata: row.metadata,
    name: row.slug,
    version: row.version,
    body: row.body,
    resources: resources.value,
  });
};

export const listAvailableChatSkillResources = async ({
  activeSkillId,
  organizationId,
  safeDb,
  skillName,
  userId,
}: ChatSkillContext & {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  skillName: string;
}): Promise<Result<SkillResource[], SafeDbError>> => {
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
    return Result.ok(listSkillResources(skillName));
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
  return resources;
};

export type AvailableChatSkillResourceRead = {
  content: string;
  /** DB row id when the skill is installed; `null` for built-in
   *  skills that live on disk and have no row to mutate. */
  skillId: SafeId<"agentSkill"> | null;
  origin: "authored" | "built-in" | "bundled" | "upload" | "url";
};

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
    return Result.ok({
      content: readSkillResource({
        resourcePath: path,
        skillId: skillName,
      }),
      skillId: null,
      origin: "built-in",
    });
  }

  const resources = await safeDb((tx) =>
    tx
      .select({
        content: agentSkillResources.content,
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

  return Result.ok({
    content: resources.value.at(0)?.content ?? "",
    skillId: row.id,
    origin: row.origin,
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
      source: "installed",
      version: row.version,
    });
  }

  for (const skill of getChatSkillMetadata()) {
    if (seen.has(skill.name)) {
      continue;
    }
    seen.add(skill.name);
    skills.push({
      ...skill,
      id: skill.name,
      source: "built-in",
    });
  }

  return skills.toSorted((a, b) => a.name.localeCompare(b.name));
};

const scopePriority = (scope: "team" | "private") =>
  scope === "private" ? 0 : 1;

const activeSkillPriority = (
  skillId: SafeId<"agentSkill">,
  activeSkillId: SafeId<"agentSkill"> | undefined,
) => (skillId === activeSkillId ? 0 : 1);
