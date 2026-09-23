import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { agentSkills } from "@/api/db/schema";
import type { AgentSkillScope } from "@/api/db/schema";
import { canManageSkill } from "@/api/lib/agent-skills/access";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { MemberRole } from "@/api/lib/member-roles";

type SkillManagementAction = "edit" | "delete";

type RequireSkillManagerOptions = {
  skill: { scope: AgentSkillScope; userId: string };
  memberRole: { role: MemberRole };
  userId: SafeId<"user">;
  action: SkillManagementAction;
};

export const requireSkillManager = ({
  skill,
  memberRole,
  userId,
  action,
}: RequireSkillManagerOptions): Result<void, HandlerError> => {
  if (canManageSkill({ skill, memberRole, userId })) {
    return Result.ok(undefined);
  }
  return Result.err(
    new HandlerError({
      status: 403,
      message:
        skill.scope === "team"
          ? `Only admins and owners can ${action} team skills`
          : "Forbidden",
    }),
  );
};

export type LoadManagedSkillOptions = Omit<
  RequireSkillManagerOptions,
  "skill"
> & {
  safeDb: SafeDb;
  skillId: SafeId<"agentSkill">;
  organizationId: SafeId<"organization">;
};

/** Load a skill of the caller's organization that the caller may manage. */
export const loadManagedSkill = async ({
  safeDb,
  skillId,
  organizationId,
  ...access
}: LoadManagedSkillOptions) =>
  await Result.gen(async function* () {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkills.id,
            origin: agentSkills.origin,
            scope: agentSkills.scope,
            userId: agentSkills.userId,
            slug: agentSkills.slug,
          })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.id, skillId),
              eq(agentSkills.organizationId, organizationId),
            ),
          )
          .limit(1),
      ),
    );
    const skill = rows.at(0);
    if (!skill) {
      return Result.err(
        new HandlerError({ status: 404, message: "Skill not found" }),
      );
    }
    yield* requireSkillManager({ skill, ...access });
    return Result.ok(skill);
  });
