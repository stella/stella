import { and, eq } from "drizzle-orm";

import type { roles } from "@stll/permissions";

import type { Transaction } from "@/api/db/root";
import { agentSkills } from "@/api/db/schema";
import type { AgentSkillOrigin, AgentSkillScope } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { includes } from "@/api/lib/type-guards";

type LoadVisibleSkillOptions = {
  skillId: SafeId<"agentSkill">;
  organizationId: SafeId<"organization">;
  /** Row lock to hold for the rest of the transaction, for a read-then-write. */
  lock?: "update";
};

type VisibleSkill = {
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

const SKILL_MANAGER_ROLES = ["admin", "owner"] as const;

type CanManageSkillOptions = {
  skill: Pick<VisibleSkill, "scope" | "userId">;
  memberRole: { role: keyof typeof roles };
  userId: SafeId<"user">;
};

/**
 * Who may write to a skill directly (edit it, accept a proposal against it,
 * remove someone else's proposal or comment): admins and owners for team
 * skills, the author for private ones. Everyone else who can see the skill
 * proposes and comments instead.
 */
export const canManageSkill = ({
  skill,
  memberRole,
  userId,
}: CanManageSkillOptions): boolean => {
  switch (skill.scope) {
    case "team":
      return includes(SKILL_MANAGER_ROLES, memberRole.role);
    case "private":
      return skill.userId === userId;
  }
};
