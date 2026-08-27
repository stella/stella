import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillComments } from "@/api/db/schema";
import {
  canManageSkill,
  loadVisibleSkill,
} from "@/api/lib/agent-skills/access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteSkillCommentParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
  commentId: tSafeId("agentSkillComment"),
});

const config = {
  description:
    "Delete a comment on an agent skill. Only its author or someone who may " +
    "edit the skill can.",
  permissions: { agentSkill: ["comment"] },
  access: "write",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: deleteSkillCommentParamsSchema,
} satisfies HandlerConfig;

const deleteSkillComment = createSafeRootHandler(
  config,
  async function* ({
    memberRole,
    params,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const skill = await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        const rows = await tx
          .select({
            id: agentSkillComments.id,
            authorId: agentSkillComments.authorId,
            revisionId: agentSkillComments.revisionId,
            proposalId: agentSkillComments.proposalId,
          })
          .from(agentSkillComments)
          .where(
            and(
              eq(agentSkillComments.id, params.commentId),
              eq(agentSkillComments.skillId, params.skillId),
              eq(
                agentSkillComments.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .limit(1);

        const existing = rows.at(0);
        if (!existing) {
          throw new HandlerError({
            status: 404,
            message: "Comment not found",
          });
        }
        if (
          existing.authorId !== user.id &&
          !canManageSkill({ skill, memberRole, userId: user.id })
        ) {
          throw new HandlerError({ status: 403, message: "Forbidden" });
        }

        await tx
          .delete(agentSkillComments)
          .where(eq(agentSkillComments.id, existing.id));

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL_COMMENT,
          resourceId: existing.id,
          metadata: {
            skillId: params.skillId,
            revisionId: existing.revisionId,
            proposalId: existing.proposalId,
          },
        });
      }),
    );

    return Result.ok({ ok: true });
  },
);

export default deleteSkillComment;
