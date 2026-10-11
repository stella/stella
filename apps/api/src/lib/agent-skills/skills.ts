import { panic, Result } from "better-result";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import {
  listSkillMetadata,
  loadSkill,
  readSkillRequiredTools,
  readSkillResource,
} from "@stll/skills";
import type { SkillResource } from "@stll/skills";
import type { SkillResourceKind } from "@stll/skills/format";
import {
  readDocumentedChatReads,
  readExcludedChatTools,
  readSkillDisplayName,
} from "@stll/skills/frontmatter";
import type { SkillMetadata } from "@stll/skills/frontmatter";

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
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

/**
 * Where a chat skill comes from: an `agent_skills` row, or a skill shipped
 * with stella (`@stll/skills`), which every organization has with no row, so
 * it carries no id, owner, content hash, or revisions.
 */
export const CHAT_SKILL_SOURCE = {
  builtIn: "built-in",
  installed: "installed",
} as const;

/** The subject a skill read is audited and reported under. */
export type ChatSkillRef =
  | {
      source: typeof CHAT_SKILL_SOURCE.installed;
      id: SafeId<"agentSkill">;
      origin: AgentSkillOrigin;
    }
  | { source: typeof CHAT_SKILL_SOURCE.builtIn };

/** The `origin` a served skill reports: its row's, or built-in. */
export const chatSkillOrigin = (
  skill: ChatSkillRef,
): AgentSkillOrigin | typeof CHAT_SKILL_SOURCE.builtIn => {
  switch (skill.source) {
    case CHAT_SKILL_SOURCE.installed:
      return skill.origin;
    case CHAT_SKILL_SOURCE.builtIn:
      return CHAT_SKILL_SOURCE.builtIn;
    default: {
      skill satisfies never;
      return panic("chat skill has an unknown source");
    }
  }
};

/** A served skill's row id; `null` for a built-in, which has no row. */
export const chatSkillId = (
  skill:
    | { source: typeof CHAT_SKILL_SOURCE.installed; id: SafeId<"agentSkill"> }
    | { source: typeof CHAT_SKILL_SOURCE.builtIn },
): SafeId<"agentSkill"> | null => {
  switch (skill.source) {
    case CHAT_SKILL_SOURCE.installed:
      return skill.id;
    case CHAT_SKILL_SOURCE.builtIn:
      return null;
    default: {
      skill satisfies never;
      return panic("chat skill has an unknown source");
    }
  }
};

export type AvailableChatSkill = SkillMetadata & {
  displayName: string;
} & (
    | { source: typeof CHAT_SKILL_SOURCE.installed; id: SafeId<"agentSkill"> }
    | { source: typeof CHAT_SKILL_SOURCE.builtIn }
  );

/** Shipped skills by name, parsed once from the deployed bytes. */
let builtInSkillNames: ReadonlySet<string> | undefined;

const isBuiltInSkill = (skillName: string): boolean => {
  builtInSkillNames ??= new Set(listSkillMetadata().map(({ name }) => name));
  return builtInSkillNames.has(skillName);
};

/**
 * Whether `slug` names a built-in for this caller: an enabled installed row
 * the caller can use shadows the built-in with the same slug, everywhere a
 * skill is resolved by name. `enabledInstalledSlugs` holds those rows' slugs.
 */
export const resolvesToBuiltInSkill = (
  slug: string,
  enabledInstalledSlugs: { has: (slug: string) => boolean },
): boolean => !enabledInstalledSlugs.has(slug) && isBuiltInSkill(slug);

export const ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS = 30_000;

type ChatSkillContext = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

/**
 * A built-in has no row, so `skillName` alone names it, unless an enabled
 * installed row with that slug shadows it, as on every other path.
 */
type ActiveChatSkillRequest = {
  skillId?: SafeId<"agentSkill"> | undefined;
  skillName: string;
};

type ChatMemberRole = AuthorizedMemberRole;

/**
 * The active skill as resolved from its source, before any surface acts on
 * it. The two frontmatter lists are the declared strings: which names chat
 * can honour is a chat decision, made once in
 * `handlers/chat/active-skill-context.ts`, which is the type chat code reads.
 */
export type ActiveSkillContext = {
  body: string;
  description: string;
  displayName: string;
  /** `stella-chat-documented-reads`, as declared. */
  documentedChatReads: readonly string[];
  /** `stella-chat-excluded-tools`, as declared. */
  excludedChatTools: readonly string[];
  /** `stella-required-tools`, as declared. */
  requiredTools: readonly string[];
  resources: SkillResource[];
  toolName: string;
  version: string | null;
} & (
  | {
      source: typeof CHAT_SKILL_SOURCE.installed;
      editable: boolean;
      id: SafeId<"agentSkill">;
      origin: AgentSkillOrigin;
    }
  | {
      source: typeof CHAT_SKILL_SOURCE.builtIn;
      editable: false;
      id: null;
      origin: typeof CHAT_SKILL_SOURCE.builtIn;
    }
);

export const resolveActiveSkillContext = async ({
  activeSkill,
  memberRole,
  organizationId,
  safeDb,
  userId,
}: ChatSkillContext & {
  activeSkill: ActiveChatSkillRequest | undefined;
  memberRole: ChatMemberRole;
}): Promise<
  Result<ActiveSkillContext | null, HandlerError<403 | 404> | SafeDbError>
> => {
  if (!activeSkill) {
    return Result.ok(null);
  }

  const { skillId, skillName } = activeSkill;
  if (skillId !== undefined) {
    return await resolveInstalledActiveSkill({
      activeSkill: { skillId, skillName },
      memberRole,
      organizationId,
      safeDb,
      userId,
    });
  }

  const installed = await findInstalledSkills({
    organizationId,
    safeDb,
    skillNames: [skillName],
    userId,
  });
  if (Result.isError(installed)) {
    return Result.err(installed.error);
  }
  if (!resolvesToBuiltInSkill(skillName, installed.value)) {
    const row = installed.value.get(skillName);
    if (!row) {
      return Result.err(
        new HandlerError({ status: 404, message: "Skill not found" }),
      );
    }
    return await resolveInstalledActiveSkill({
      activeSkill: { skillId: row.id, skillName },
      memberRole,
      organizationId,
      safeDb,
      userId,
    });
  }

  const skill = loadSkill(skillName);
  return Result.ok({
    body: skill.body,
    description: skill.description,
    displayName: readSkillDisplayName(skill),
    documentedChatReads: readDocumentedChatReads(skill.metadata),
    editable: false,
    excludedChatTools: readExcludedChatTools(skill.metadata),
    id: null,
    origin: CHAT_SKILL_SOURCE.builtIn,
    requiredTools: readSkillRequiredTools(skill.metadata),
    resources: skill.resources,
    source: CHAT_SKILL_SOURCE.builtIn,
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
  activeSkill: { skillId: SafeId<"agentSkill">; skillName: string };
  memberRole: ChatMemberRole;
}): Promise<
  Result<ActiveSkillContext, HandlerError<403 | 404> | SafeDbError>
> => {
  const skillRows = await safeDb((tx) =>
    tx
      .select({
        id: agentSkills.id,
        body: agentSkills.body,
        description: agentSkills.description,
        enabled: agentSkills.enabled,
        metadata: agentSkills.metadata,
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
    documentedChatReads: readDocumentedChatReads(skill.metadata),
    editable: canEditActiveSkill({
      memberRole,
      origin: skill.origin,
      scope: skill.scope,
      skillUserId: skill.userId,
      userId,
    }),
    excludedChatTools: readExcludedChatTools(skill.metadata),
    id: skill.id,
    origin: skill.origin,
    requiredTools: readSkillRequiredTools(skill.metadata),
    resources: resources.value,
    source: CHAT_SKILL_SOURCE.installed,
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
    !canManageSkill({
      memberRole,
      skill: { scope, userId: skillUserId },
      userId,
      spends: "update",
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

/** A skill the caller can load right now, with the source it came from. */
export type LoadedChatSkill = {
  body: string;
  compatibility: string | null;
  description: string;
  license: string | null;
  metadata: Record<string, string>;
  /** The skill slug: the name the catalog and the skill tools use. */
  name: string;
  resources: { kind: SkillResourceKind; path: string }[];
  version: string | null;
} & ChatSkillRef;

/**
 * Resolves `skillName` against the caller's skills when the tool runs, not
 * when the catalog was built. `null` means the skill is no longer available
 * (deleted, disabled, or renamed since), which callers report as not found.
 */
export const loadAvailableChatSkill = async ({
  skillName,
  ...context
}: ChatSkillContext & {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  skillName: string;
}): Promise<Result<LoadedChatSkill | null, SafeDbError>> =>
  (await loadAvailableChatSkills({ ...context, skillNames: [skillName] })).map(
    (loaded) => loaded.get(skillName) ?? null,
  );

/**
 * `loadAvailableChatSkill` for several names in two queries. A name missing
 * from the result is not available to the caller. An enabled row shadows the
 * built-in with the same slug, as in the catalog.
 */
export const loadAvailableChatSkills = async ({
  activeSkillId,
  organizationId,
  safeDb,
  skillNames,
  userId,
}: ChatSkillContext & {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  skillNames: readonly string[];
}): Promise<Result<Map<string, LoadedChatSkill>, SafeDbError>> => {
  const rowsResult = await findInstalledSkills({
    activeSkillId,
    organizationId,
    safeDb,
    skillNames,
    userId,
  });
  if (Result.isError(rowsResult)) {
    return Result.err(rowsResult.error);
  }
  const rows = [...rowsResult.value.values()];
  const builtIns = skillNames
    .filter((name) => resolvesToBuiltInSkill(name, rowsResult.value))
    .map((name): [string, LoadedChatSkill] => [name, loadBuiltInSkill(name)]);
  if (rows.length === 0) {
    return Result.ok(new Map(builtIns));
  }

  const resources = await safeDb((tx) =>
    tx
      .select({
        kind: agentSkillResources.kind,
        path: agentSkillResources.path,
        skillId: agentSkillResources.skillId,
      })
      .from(agentSkillResources)
      .where(
        inArray(
          agentSkillResources.skillId,
          rows.map(({ id }) => id),
        ),
      )
      .orderBy(agentSkillResources.path)
      .limit(LIMITS.agentSkillResourcesPerSkill * rows.length),
  );
  if (Result.isError(resources)) {
    return Result.err(resources.error);
  }

  return Result.ok(
    new Map([
      ...rows.map((row): [string, LoadedChatSkill] => [
        row.slug,
        {
          body: row.body,
          compatibility: row.compatibility,
          description: row.description,
          id: row.id,
          license: row.license,
          metadata: row.metadata,
          name: row.slug,
          origin: row.origin,
          resources: resources.value
            .filter(({ skillId }) => skillId === row.id)
            .slice(0, LIMITS.agentSkillResourcesPerSkill)
            .map(({ kind, path }) => ({ kind, path })),
          source: CHAT_SKILL_SOURCE.installed,
          version: row.version,
        },
      ]),
      ...builtIns,
    ]),
  );
};

const loadBuiltInSkill = (skillName: string): LoadedChatSkill => {
  const skill = loadSkill(skillName);
  return {
    body: skill.body,
    compatibility: skill.compatibility ?? null,
    description: skill.description,
    license: skill.license ?? null,
    metadata: skill.metadata ?? {},
    name: skill.name,
    resources: skill.resources,
    source: CHAT_SKILL_SOURCE.builtIn,
    version: skill.version,
  };
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
      skill: ChatSkillRef;
    }
  | {
      status: typeof SKILL_RESOURCE_READ_STATUS.resourceNotFound;
      skill: ChatSkillRef;
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
  const rowResult = await findInstalledSkills({
    activeSkillId,
    organizationId,
    safeDb,
    skillNames: [skillName],
    userId,
  });
  if (Result.isError(rowResult)) {
    return Result.err(rowResult.error);
  }

  const row = rowResult.value.get(skillName);
  if (!row) {
    return Result.ok(readBuiltInSkillResource({ path, skillName }));
  }
  const skill: ChatSkillRef = {
    source: CHAT_SKILL_SOURCE.installed,
    id: row.id,
    origin: row.origin,
  };

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
      skill,
    });
  }

  return Result.ok({
    status: SKILL_RESOURCE_READ_STATUS.found,
    content: resource.content,
    kind: resource.kind,
    skill,
  });
};

const readBuiltInSkillResource = ({
  path,
  skillName,
}: {
  path: string;
  skillName: string;
}): AvailableChatSkillResourceRead => {
  if (!isBuiltInSkill(skillName)) {
    return { status: SKILL_RESOURCE_READ_STATUS.skillNotFound };
  }
  const skill: ChatSkillRef = { source: CHAT_SKILL_SOURCE.builtIn };
  const resource = readSkillResource({
    resourcePath: path,
    skillId: skillName,
  });
  if (resource === null) {
    return { status: SKILL_RESOURCE_READ_STATUS.resourceNotFound, skill };
  }
  return {
    status: SKILL_RESOURCE_READ_STATUS.found,
    content: resource.content,
    kind: resource.kind,
    skill,
  };
};

/** The row each name resolves to for the caller, keyed by slug. */
const findInstalledSkills = async ({
  activeSkillId,
  organizationId,
  safeDb,
  skillNames,
  userId,
}: ChatSkillContext & {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  skillNames: readonly string[];
}) => {
  if (skillNames.length === 0) {
    return Result.ok(new Map<string, InstalledSkillRow>());
  }
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
          inArray(agentSkills.slug, [...skillNames]),
          or(eq(agentSkills.scope, "team"), eq(agentSkills.userId, userId)),
        ),
      )
      .limit(LIMITS.agentSkillsPerUser),
  );
  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }

  const bySlug = new Map<string, InstalledSkillRow>();
  for (const row of rows.value.toSorted(
    (a, b) =>
      activeSkillPriority(a.id, activeSkillId) -
        activeSkillPriority(b.id, activeSkillId) ||
      scopePriority(a.scope) - scopePriority(b.scope) ||
      // oxlint-disable-next-line require-cached-collator/require-cached-collator -- id tiebreak for deterministic ordering, not display text
      a.id.localeCompare(b.id),
  )) {
    if (!bySlug.has(row.slug)) {
      bySlug.set(row.slug, row);
    }
  }
  return Result.ok(bySlug);
};

type InstalledSkillRow = {
  body: string;
  compatibility: string | null;
  description: string;
  id: SafeId<"agentSkill">;
  license: string | null;
  metadata: Record<string, string>;
  origin: AgentSkillOrigin;
  scope: "team" | "private";
  slug: string;
  version: string | null;
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

/**
 * One entry per slug: a private row shadows a team row, and an enabled row
 * shadows the built-in with the same slug. The row cap bounds installed rows
 * only, so an organization at the cap still has every shipped skill.
 */
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
      source: CHAT_SKILL_SOURCE.installed,
      version: row.version,
    });
  }

  for (const skill of listSkillMetadata()) {
    if (seen.has(skill.name)) {
      continue;
    }
    seen.add(skill.name);
    skills.push({
      ...skill,
      displayName: readSkillDisplayName(skill),
      source: CHAT_SKILL_SOURCE.builtIn,
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
