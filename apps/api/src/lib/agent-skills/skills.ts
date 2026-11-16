import { panic, Result } from "better-result";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import {
  listSkillMetadata,
  loadSkill,
  readSkillRequiredTools,
  readSkillResource,
} from "@stll/skills";
import type { SkillResource } from "@stll/skills";
import {
  readDocumentedChatReads,
  readExcludedChatTools,
  readSkillDisplayName,
} from "@stll/skills/frontmatter";
import type { SkillInvocation, SkillMetadata } from "@stll/skills/frontmatter";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  type AgentSkillOrigin,
  agentSkillResources,
  agentSkills,
} from "@/api/db/schema";
import {
  canEditActiveSkill,
  canReadActiveSkillBody,
} from "@/api/lib/agent-skills/access";
import { skillBindingCondition, UNBOUND } from "@/api/lib/agent-skills/binding";
import type {
  SkillBinding,
  SkillBindingScope,
} from "@/api/lib/agent-skills/binding";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
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
  /** Applied by `offerSkillsToModel` before any model sees the skill. */
  invocation: SkillInvocation;
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

type ChatSkillCaller = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

type ChatSkillContext = ChatSkillCaller & {
  /**
   * Where the conversation may use a bound skill. Required on every read
   * that serves a skill to a model, so none can skip the binding.
   */
  bindingScope: SkillBindingScope;
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
  /**
   * The skill's binding, checked against the turn's binding scope once the
   * turn's matters are known (`skillBindingAllows`); null on both for an
   * unbound or built-in skill.
   */
  binding: SkillBinding;
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

/**
 * Resolved before the turn's matters are known, so it reads any skill row
 * security lets the caller see; the turn then checks `binding` against its
 * binding scope and refuses a skill bound elsewhere.
 */
export const resolveActiveSkillContext = async ({
  activeSkill,
  memberRole,
  organizationId,
  safeDb,
  userId,
}: ChatSkillCaller & {
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
    bindingScope: ANY_READABLE_BINDING,
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
    binding: UNBOUND,
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
}: ChatSkillCaller & {
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
        boundClientId: agentSkills.boundClientId,
        boundWorkspaceId: agentSkills.boundWorkspaceId,
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
      boundClientId: skill.boundClientId,
      boundWorkspaceId: skill.boundWorkspaceId,
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
    binding: {
      boundClientId: skill.boundClientId,
      boundWorkspaceId: skill.boundWorkspaceId,
    },
    body: skill.body,
    description: skill.description,
    displayName: skill.name,
    documentedChatReads: readDocumentedChatReads(skill.metadata),
    editable: canEditActiveSkill({
      boundClientId: skill.boundClientId,
      boundWorkspaceId: skill.boundWorkspaceId,
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

export const listAvailableChatSkillMetadata = async ({
  bindingScope,
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
        invocation: agentSkills.invocation,
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
          skillBindingCondition(bindingScope),
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
  contentHash: string | null;
  description: string;
  license: string | null;
  metadata: Record<string, string>;
  /** The skill slug: the name the catalog and the skill tools use. */
  name: string;
  resources: { path: string }[];
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
  bindingScope,
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
    bindingScope,
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
          contentHash: row.contentHash,
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
            .map(({ path }) => ({ path })),
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
    contentHash: null,
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
      contentHash: string | null;
      skill: ChatSkillRef;
    }
  | {
      status: typeof SKILL_RESOURCE_READ_STATUS.resourceNotFound;
      skill: ChatSkillRef;
    }
  | { status: typeof SKILL_RESOURCE_READ_STATUS.skillNotFound };

export const readAvailableChatSkillResource = async ({
  activeSkillId,
  bindingScope,
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
    bindingScope,
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
    contentHash: row.contentHash,
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
    contentHash: null,
    skill,
  };
};

/**
 * Active-skill resolution only: any row the caller may read, whatever its
 * binding, because the turn checks the binding once its matters are known.
 */
const ANY_READABLE_BINDING = Symbol("any readable binding");

/**
 * The row each name resolves to for the caller, keyed by slug. A row outside
 * `bindingScope` is not a candidate, so a bound skill can neither be served
 * nor shadow an unbound one with the same slug outside its binding.
 */
const findInstalledSkills = async ({
  activeSkillId,
  bindingScope,
  includeDisabled = false,
  organizationId,
  safeDb,
  skillNames,
  userId,
}: ChatSkillCaller & {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  bindingScope: SkillBindingScope | typeof ANY_READABLE_BINDING;
  includeDisabled?: boolean | undefined;
  skillNames: readonly string[];
}) => {
  if (skillNames.length === 0) {
    return Result.ok(new Map<string, InstalledSkillRow>());
  }
  const activeSkillEnabledCondition =
    activeSkillId === undefined
      ? eq(agentSkills.enabled, true)
      : or(eq(agentSkills.enabled, true), eq(agentSkills.id, activeSkillId));
  const enabledOrActive = includeDisabled
    ? undefined
    : activeSkillEnabledCondition;

  const rows = await safeDb((tx) =>
    tx
      .select({
        boundClientId: agentSkills.boundClientId,
        boundWorkspaceId: agentSkills.boundWorkspaceId,
        contentHash: agentSkills.contentHash,
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
          bindingScope === ANY_READABLE_BINDING
            ? undefined
            : skillBindingCondition(bindingScope),
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
  boundClientId: SafeId<"contact"> | null;
  boundWorkspaceId: SafeId<"workspace"> | null;
  contentHash: string;
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

/**
 * Resolves installed skills already loaded into chat history by immutable row
 * id, never by their reusable slug. Current row visibility remains authoritative:
 * an inaccessible or deleted identity is absent and therefore withheld.
 */
export type ReadableChatSkillBinding = SkillBinding & {
  contentHash: string;
};

export const loadReadableChatSkillBindings = async ({
  organizationId,
  safeDb,
  skillIds,
  userId,
}: ChatSkillCaller & {
  skillIds: readonly SafeId<"agentSkill">[];
}): Promise<Result<Map<string, ReadableChatSkillBinding>, SafeDbError>> => {
  const uniqueSkillIds = [...new Set(skillIds)];
  if (uniqueSkillIds.length === 0) {
    return Result.ok(new Map());
  }
  const rows = await safeDb(async (tx) => {
    const read = await readBounded(
      tx
        .select({
          boundClientId: agentSkills.boundClientId,
          boundWorkspaceId: agentSkills.boundWorkspaceId,
          contentHash: agentSkills.contentHash,
          id: agentSkills.id,
        })
        .from(agentSkills)
        .where(
          and(
            eq(agentSkills.organizationId, organizationId),
            inArray(agentSkills.id, uniqueSkillIds),
            or(eq(agentSkills.scope, "team"), eq(agentSkills.userId, userId)),
          ),
        ),
      uniqueSkillIds.length,
    );
    if (read.type === "overflow") {
      return panic("Readable chat skill bindings exceeded their bounded read", {
        cap: read.cap,
      });
    }
    return read.rows;
  });
  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }
  return Result.ok(
    new Map(
      rows.value.map(({ boundClientId, boundWorkspaceId, contentHash, id }) => [
        id,
        { boundClientId, boundWorkspaceId, contentHash },
      ]),
    ),
  );
};

type InstalledSkillMetadataRow = {
  compatibility: string | null;
  description: string;
  id: SafeId<"agentSkill">;
  invocation: SkillInvocation;
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
      invocation: row.invocation,
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
