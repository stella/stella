import { Result } from "better-result";
import { inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { agentSkills, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

const skillBindingScopeBrand = Symbol("stella.skillBindingScope");

/**
 * Where a model may use a bound skill right now: the one matter, or the one
 * client, that every matter of the conversation shares. Only
 * `resolveSkillBindingScope` and `NO_SKILL_BINDING_SCOPE` make one, so no
 * caller can name a matter it did not derive from the conversation.
 */
export type SkillBindingScope = {
  readonly [skillBindingScopeBrand]: true;
  readonly clientId: SafeId<"contact"> | null;
  readonly matterId: SafeId<"workspace"> | null;
};

const bindingScope = ({
  clientId,
  matterId,
}: {
  clientId: SafeId<"contact"> | null;
  matterId: SafeId<"workspace"> | null;
}): SkillBindingScope => ({
  [skillBindingScopeBrand]: true,
  clientId,
  matterId,
});

/**
 * Unbound skills only: a surface with no conversation matter (MCP, one-shot
 * generators, a global chat) never offers a bound skill.
 */
export const NO_SKILL_BINDING_SCOPE: SkillBindingScope = bindingScope({
  clientId: null,
  matterId: null,
});

/**
 * The binding scope of a conversation that lives in `homeWorkspaceId` and
 * also draws on `otherWorkspaceIds` (pinned matters, embedded data). It fails
 * closed:
 * - no home matter: unbound skills only;
 * - the matter binding holds only when every matter is the home matter;
 * - the client binding holds only when every matter has the same client, read
 *   under the caller's own matter access (an unreadable matter breaks it).
 */
export const resolveSkillBindingScope = async ({
  homeWorkspaceId,
  otherWorkspaceIds,
  safeDb,
}: {
  homeWorkspaceId: SafeId<"workspace"> | null;
  otherWorkspaceIds: readonly SafeId<"workspace">[];
  safeDb: SafeDb;
}): Promise<Result<SkillBindingScope, SafeDbError>> => {
  if (homeWorkspaceId === null) {
    return Result.ok(NO_SKILL_BINDING_SCOPE);
  }
  const matterIds = [...new Set([homeWorkspaceId, ...otherWorkspaceIds])];

  const rows = await safeDb((tx) =>
    tx
      .select({ clientId: workspaces.clientId, id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.id, matterIds))
      .limit(matterIds.length),
  );
  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }
  // Both bindings hold only over matters the caller can read right now.
  const everyMatterReadable = rows.value.length === matterIds.length;
  const matterId =
    everyMatterReadable && matterIds.length === 1 ? homeWorkspaceId : null;
  const clientIds = new Set(rows.value.map(({ clientId }) => clientId));
  const [onlyClientId] = [...clientIds];
  const clientId =
    everyMatterReadable && clientIds.size === 1 && onlyClientId !== undefined
      ? onlyClientId
      : null;

  return Result.ok(bindingScope({ clientId, matterId }));
};

/** A skill's binding: the matter or the client it is bound to, if any. */
export type SkillBinding = {
  boundClientId: SafeId<"contact"> | null;
  boundWorkspaceId: SafeId<"workspace"> | null;
};

export const UNBOUND: SkillBinding = {
  boundClientId: null,
  boundWorkspaceId: null,
};

/**
 * Whether a skill with `binding` may be used under `scope`: the same rule as
 * `skillBindingCondition`, for a skill already in hand (the thread's active
 * skill, resolved before the turn's matters were known).
 */
export const skillBindingAllows = (
  scope: SkillBindingScope,
  binding: SkillBinding,
): boolean => {
  if (binding.boundWorkspaceId !== null) {
    return binding.boundWorkspaceId === scope.matterId;
  }
  if (binding.boundClientId !== null) {
    return binding.boundClientId === scope.clientId;
  }
  return true;
};

/**
 * The `agent_skills` rows a model may use under `scope`: unbound ones, plus
 * those bound to its matter or its client. Every query that serves a skill to
 * a model applies it; the reach a user needs to read a bound skill at all is
 * row security's job (`agentSkillPolicies`).
 */
export const skillBindingCondition = (scope: SkillBindingScope): SQL => {
  const allowed: SQL[] = [
    sql`(${agentSkills.boundWorkspaceId} IS NULL AND ${agentSkills.boundClientId} IS NULL)`,
  ];
  if (scope.matterId !== null) {
    allowed.push(sql`${agentSkills.boundWorkspaceId} = ${scope.matterId}`);
  }
  if (scope.clientId !== null) {
    allowed.push(sql`${agentSkills.boundClientId} = ${scope.clientId}`);
  }
  return sql`(${sql.join(allowed, sql` OR `)})`;
};
