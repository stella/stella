import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillProposals, agentSkills } from "@/api/db/schema";
import {
  canManageSkill,
  loadVisibleSkill,
} from "@/api/lib/agent-skills/access";
import { hashAuthoredSkillContent } from "@/api/lib/agent-skills/authored-content-hash";
import { isDecidedProposalStatus } from "@/api/lib/agent-skills/proposal-status";
import { loadLatestSkillRevision } from "@/api/lib/agent-skills/revisions";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const reviewSkillProposalParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
  proposalId: tSafeId("agentSkillProposal"),
});

const reviewSkillProposalBodySchema = t.Object({
  decision: t.UnionEnum(["accepted", "rejected"]),
  // Accepting a proposal whose base is no longer the current revision
  // discards every edit made since; the reviewer must say so explicitly.
  allowStale: t.Optional(t.Boolean()),
});

const config = {
  description:
    "Accept or reject a change proposal for an agent skill. Accepting writes " +
    "the proposed body to the skill and records the revision it produced; " +
    "rejecting leaves the skill untouched. Either way the decision is final. " +
    "Requires the rights to edit the skill itself.",
  permissions: { agentSkill: ["update"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: reviewSkillProposalParamsSchema,
  body: reviewSkillProposalBodySchema,
} satisfies HandlerConfig;

type ReviewSkillProposalResult = {
  id: SafeId<"agentSkillProposal">;
  status: "accepted" | "rejected";
  resultRevisionId: SafeId<"agentSkillRevision"> | null;
};

const reviewSkillProposal = createSafeRootHandler(
  config,
  async function* ({
    body,
    memberRole,
    params,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const decided = yield* Result.await(
      abortableTx(safeDb, async (tx): Promise<ReviewSkillProposalResult> => {
        const skill = await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
          lock: "update",
        });
        if (!canManageSkill({ skill, memberRole, userId: user.id })) {
          throw new HandlerError({ status: 403, message: "Forbidden" });
        }

        const rows = await tx
          .select({
            id: agentSkillProposals.id,
            body: agentSkillProposals.body,
            status: agentSkillProposals.status,
            baseRevisionId: agentSkillProposals.baseRevisionId,
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

        const proposal = rows.at(0);
        if (!proposal) {
          throw new HandlerError({
            status: 404,
            message: "Proposal not found",
          });
        }
        if (isDecidedProposalStatus(proposal.status)) {
          throw new HandlerError({
            status: 409,
            message: "Proposal has already been decided",
          });
        }

        const decidedAt = new Date();

        if (body.decision === "rejected") {
          await tx
            .update(agentSkillProposals)
            .set({
              status: "rejected",
              reviewerId: user.id,
              decidedAt,
            })
            .where(eq(agentSkillProposals.id, proposal.id));

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.REVIEW,
            resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL,
            resourceId: proposal.id,
            changes: { status: { old: proposal.status, new: "rejected" } },
            metadata: { skillId: params.skillId },
          });

          return {
            id: proposal.id,
            status: "rejected",
            resultRevisionId: null,
          };
        }

        const currentRevision = await loadLatestSkillRevision(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });
        if (
          currentRevision !== undefined &&
          currentRevision.id !== proposal.baseRevisionId &&
          body.allowStale !== true
        ) {
          throw new HandlerError({
            status: 409,
            message:
              "The skill changed since this proposal was written; pass allowStale to accept it anyway",
          });
        }
        // The revision trigger coalesces consecutive saves by the same author;
        // an accepted proposal must land as its own revision so it can be
        // linked back as the result.
        await tx.execute(
          sql`SET LOCAL app.agent_skill_revision_mode = 'isolated'`,
        );

        await tx
          .update(agentSkills)
          .set({
            body: proposal.body,
            contentHash: hashAuthoredSkillContent({
              body: proposal.body,
              description: skill.description,
              name: skill.name,
              version: skill.version,
            }),
          })
          .where(
            and(
              eq(agentSkills.id, params.skillId),
              eq(agentSkills.organizationId, session.activeOrganizationId),
            ),
          );

        const resultRevision = await loadLatestSkillRevision(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });
        if (!resultRevision) {
          panic("agent skill has no revision");
        }

        await tx
          .update(agentSkillProposals)
          .set({
            status: "accepted",
            reviewerId: user.id,
            decidedAt,
            resultRevisionId: resultRevision.id,
          })
          .where(eq(agentSkillProposals.id, proposal.id));

        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.REVIEW,
            resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL,
            resourceId: proposal.id,
            changes: { status: { old: proposal.status, new: "accepted" } },
            metadata: {
              skillId: params.skillId,
              resultRevisionId: resultRevision.id,
            },
          },
          {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
            resourceId: params.skillId,
            changes: { body: { old: skill.body, new: proposal.body } },
            metadata: {
              proposalId: proposal.id,
              resultRevisionId: resultRevision.id,
            },
          },
        ]);

        return {
          id: proposal.id,
          status: "accepted",
          resultRevisionId: resultRevision.id,
        };
      }),
    );

    return Result.ok(decided);
  },
);

export default reviewSkillProposal;
