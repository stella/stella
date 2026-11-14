import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { agentSkills } from "@/api/db/schema";
import type { AgentSkillOrigin, AgentSkillScope } from "@/api/db/schema";
import type { SkillBinding } from "@/api/lib/agent-skills/binding";
import { requireEditableSkillOrigin } from "@/api/lib/agent-skills/origin";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  hasManagementPermission,
  hasMemberPermission,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

type LoadVisibleSkillOptions = {
  skillId: SafeId<"agentSkill">;
  organizationId: SafeId<"organization">;
  /** Row lock to hold for the rest of the transaction, for a read-then-write. */
  lock?: "update";
};

type VisibleSkill = {
  boundClientId: SafeId<"contact"> | null;
  boundWorkspaceId: SafeId<"workspace"> | null;
  id: SafeId<"agentSkill">;
  scope: AgentSkillScope;
  userId: string;
  origin: AgentSkillOrigin;
  name: string;
  description: string;
  version: string | null;
  body: string;
  contentHash: string;
};

/**
 * Load the skill a revision, proposal, or comment hangs off, restricted to the
 * caller's organization. Row-level security narrows this further to the team
 * skills of that organization plus the caller's own private ones, so a skill
 * the caller may not see is indistinguishable from one that does not exist.
 *
 * Aborts the surrounding transaction with a 404, so call it inside
 * `abortableTx`, where the thrown `HandlerError` becomes the handler failure.
 */
export const loadVisibleSkill = async (
  tx: Transaction,
  { skillId, organizationId, lock }: LoadVisibleSkillOptions,
): Promise<VisibleSkill> => {
  const query = tx
    .select({
      boundClientId: agentSkills.boundClientId,
      boundWorkspaceId: agentSkills.boundWorkspaceId,
      id: agentSkills.id,
      scope: agentSkills.scope,
      userId: agentSkills.userId,
      origin: agentSkills.origin,
      name: agentSkills.name,
      description: agentSkills.description,
      version: agentSkills.version,
      body: agentSkills.body,
      contentHash: agentSkills.contentHash,
    })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.id, skillId),
        eq(agentSkills.organizationId, organizationId),
      ),
    )
    .limit(1);

  const rows = lock === "update" ? await query.for("update") : await query;

  const skill = rows.at(0);
  if (!skill) {
    throw new HandlerError({ status: 404, message: "Skill not found" });
  }

  return skill;
};

type CanManageSkillOptions = {
  skill: Pick<
    VisibleSkill,
    "scope" | "userId" | "boundClientId" | "boundWorkspaceId"
  >;
  memberRole: AuthorizedMemberRole;
  userId: SafeId<"user">;
  /** The skill permission the write spends: `delete` removes the skill,
   *  `update` covers every other direct write. */
  spends: "update" | "delete";
};

/**
 * Who may write to a skill directly (edit it, accept a proposal against it,
 * remove someone else's proposal or comment, delete it), each spending the
 * permission the write needs:
 * - team skills: admins and owners, or the author of one bound to a matter;
 * - private skills: the author, and a client-bound one only as a manager.
 * Everyone else who can see the skill proposes and comments instead. Row
 * security adds the binding's reach; this mirrors `agentSkillWriteRule`.
 */
export const canManageSkill = ({
  skill,
  memberRole,
  userId,
  spends,
}: CanManageSkillOptions): boolean => {
  const permission = { agentSkill: [spends] };
  const isAuthor =
    skill.userId === userId && hasMemberPermission(memberRole, permission);
  switch (skill.scope) {
    case "team":
      return (
        hasManagementPermission(memberRole, permission) ||
        (skill.boundWorkspaceId !== null && isAuthor)
      );
    case "private":
      return (
        isAuthor &&
        (skill.boundClientId === null ||
          hasManagementPermission(memberRole, permission))
      );
    default: {
      skill.scope satisfies never;
      return panic(`Unhandled scope: ${String(skill.scope)}`);
    }
  }
};

type ActiveSkillAccessOptions = SkillBinding & {
  memberRole: AuthorizedMemberRole;
  origin: AgentSkillOrigin;
  scope: "private" | "team";
  skillUserId: string;
  userId: SafeId<"user">;
};

export const canEditActiveSkill = ({
  boundClientId,
  boundWorkspaceId,
  memberRole,
  origin,
  scope,
  skillUserId,
  userId,
}: ActiveSkillAccessOptions): boolean => {
  if (
    !canManageSkill({
      memberRole,
      skill: { boundClientId, boundWorkspaceId, scope, userId: skillUserId },
      userId,
      spends: "update",
    })
  ) {
    return false;
  }

  return !Result.isError(requireEditableSkillOrigin(origin));
};

export const canReadActiveSkillBody = ({
  boundClientId,
  boundWorkspaceId,
  enabled,
  memberRole,
  origin,
  scope,
  skillUserId,
  userId,
}: ActiveSkillAccessOptions & {
  enabled: boolean;
}): boolean => {
  if (scope === "private") {
    return skillUserId === userId;
  }

  if (enabled) {
    return true;
  }

  return canEditActiveSkill({
    boundClientId,
    boundWorkspaceId,
    memberRole,
    origin,
    scope,
    skillUserId,
    userId,
  });
};
