import { Result } from "better-result";
import { and, eq, or } from "drizzle-orm";

import {
  listSkillMetadata,
  listSkillResources,
  loadSkill,
  readSkillResource,
} from "@stll/skills";
import type { SkillMetadata, SkillResource, StellaSkill } from "@stll/skills";

import type { SafeDb, SafeDbError } from "@/api/db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type AvailableChatSkill = SkillMetadata & {
  id: string;
  source: "built-in" | "installed";
};

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
  organizationId,
  safeDb,
  skillName,
  userId,
}: ChatSkillContext & {
  skillName: string;
}): Promise<Result<StellaSkill, SafeDbError>> => {
  const rowResult = await findInstalledSkill({
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
      .orderBy(agentSkillResources.path),
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
  organizationId,
  safeDb,
  skillName,
  userId,
}: ChatSkillContext & {
  skillName: string;
}): Promise<Result<SkillResource[], SafeDbError>> => {
  const rowResult = await findInstalledSkill({
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
      .orderBy(agentSkillResources.path),
  );
  return resources;
};

export const readAvailableChatSkillResource = async ({
  organizationId,
  path,
  safeDb,
  skillName,
  userId,
}: ChatSkillContext & {
  path: string;
  skillName: string;
}): Promise<Result<string, SafeDbError>> => {
  const rowResult = await findInstalledSkill({
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
    return Result.ok(
      readSkillResource({
        resourcePath: path,
        skillId: skillName,
      }),
    );
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

  return Result.ok(resources.value.at(0)?.content ?? "");
};

const findInstalledSkill = async ({
  organizationId,
  safeDb,
  skillName,
  userId,
}: ChatSkillContext & {
  skillName: string;
}) => {
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
      })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.organizationId, organizationId),
          eq(agentSkills.enabled, true),
          eq(agentSkills.slug, skillName),
          or(eq(agentSkills.scope, "team"), eq(agentSkills.userId, userId)),
        ),
      ),
  );
  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }

  return Result.ok(
    rows.value
      .toSorted((a, b) => scopePriority(a.scope) - scopePriority(b.scope))
      .at(0) ?? null,
  );
};

type InstalledSkillMetadataRow = {
  compatibility: string | null;
  description: string;
  id: SafeId<"agentSkill">;
  license: string | null;
  metadata: Record<string, string>;
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
