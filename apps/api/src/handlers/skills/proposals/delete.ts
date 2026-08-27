import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillProposals } from "@/api/db/schema";
import {
  canManageSkill,
  loadVisibleSkill,
} from "@/api/lib/agent-skills/access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteSkillProposalParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
  proposalId: tSafeId("agentSkillProposal"),
});

const config = {
  description:
    "Delete a change proposal for an agent skill, along with the comments " +
    "anchored to it. The skill and its revisions are untouched. Only the " +
    "author or someone who may edit the skill can.",
  permissions: { agentSkill: ["propose"] },
  access: "write",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: deleteSkillProposalParamsSchema,
} satisfies HandlerConfig;

const deleteSkillProposal = createSafeRootHandler(
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
        // Locked because a concurrent decide on the same skill would
        // otherwise decide the proposal between this read and the write.
        const skill = await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
          lock: "update",
        });

        const rows = await tx
          .select({
            id: agentSkillProposals.id,
            status: agentSkillProposals.status,
            authorId: agentSkillProposals.authorId,
          })
          .from(agentSkillProposals)
          .where(
            and(
              eq(agentSkillProposals.id, params.proposalId),
              eq(agentSkillProposals.skillId, params.skillId),
              eq(
                agentSkillProposals.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .limit(1);

        const existing = rows.at(0);
        if (!existing) {
          throw new HandlerError({
            status: 404,
            message: "Proposal not found",
          });
        }
        if (
          existing.authorId !== user.id &&
          !canManageSkill({ skill, memberRole, userId: user.id })
        ) {
          throw new HandlerError({ status: 403, message: "Forbidden" });
        }

        await tx
          .delete(agentSkillProposals)
          .where(eq(agentSkillProposals.id, existing.id));

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL,
          resourceId: existing.id,
          changes: { status: { old: existing.status, new: null } },
          metadata: { skillId: params.skillId },
        });
      }),
    );

    return Result.ok({ ok: true });
  },
);

export default deleteSkillProposal;
