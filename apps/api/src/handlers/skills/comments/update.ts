import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillComments } from "@/api/db/schema";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const updateSkillCommentParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
  commentId: tSafeId("agentSkillComment"),
});

const updateSkillCommentBodySchema = t.Object({
  resolved: t.Boolean(),
});

const config = {
  description:
    "Resolve or reopen a comment on an agent skill. Anyone who can see the " +
    "skill can, not only the comment's author.",
  permissions: { agentSkill: ["comment"] },
  access: "write",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: updateSkillCommentParamsSchema,
  body: updateSkillCommentBodySchema,
} satisfies HandlerConfig;

const updateSkillComment = createSafeRootHandler(
  config,
  async function* ({ body, params, recordAuditEvent, safeDb, session, user }) {
    yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        const rows = await tx
          .select({
            id: agentSkillComments.id,
            resolvedAt: agentSkillComments.resolvedAt,
            resolvedBy: agentSkillComments.resolvedBy,
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

        const resolution = body.resolved
          ? { resolvedAt: new Date(), resolvedBy: user.id }
          : { resolvedAt: null, resolvedBy: null };

        await tx
          .update(agentSkillComments)
          .set(resolution)
          .where(eq(agentSkillComments.id, existing.id));

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL_COMMENT,
          resourceId: existing.id,
          changes: {
            resolvedAt: {
              old: existing.resolvedAt,
              new: resolution.resolvedAt,
            },
            resolvedBy: {
              old: existing.resolvedBy,
              new: resolution.resolvedBy,
            },
          },
          metadata: { skillId: params.skillId },
        });
      }),
    );

    return Result.ok({ id: params.commentId });
  },
);

export default updateSkillComment;
