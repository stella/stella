import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillProposals } from "@/api/db/schema";
import type { AgentSkillProposalStatus } from "@/api/db/schema";
import {
  canManageSkill,
  loadVisibleSkill,
} from "@/api/lib/agent-skills/access";
import { isDecidedProposalStatus } from "@/api/lib/agent-skills/proposal-status";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const updateSkillProposalParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
  proposalId: tSafeId("agentSkillProposal"),
});

const updateSkillProposalBodySchema = t.Object({
  body: t.Optional(t.String({ maxLength: LIMITS.agentSkillBodyMaxChars })),
  summary: t.Optional(
    t.String({ maxLength: LIMITS.agentSkillProposalSummaryMaxChars }),
  ),
  // Authoring statuses only: a decision is made through
  // skills.proposals.decide, never by writing the status here.
  status: t.Optional(t.Union([t.Literal("draft"), t.Literal("proposed")])),
});

const config = {
  description:
    "Edit a change proposal for an agent skill: its proposed body, its " +
    "summary, or whether it is still a draft or now up for review. Only the " +
    "author or someone who may edit the skill can, and only until the " +
    "proposal is decided.",
  permissions: { agentSkill: ["propose"] },
  access: "write",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: updateSkillProposalParamsSchema,
  body: updateSkillProposalBodySchema,
} satisfies HandlerConfig;

type ProposalUpdateFields = {
  body?: string;
  summary?: string;
  status?: AgentSkillProposalStatus;
};

type ProposalUpdateChange<T> = { old: T; new: T };

type ProposalUpdateChanges = {
  body?: ProposalUpdateChange<string>;
  summary?: ProposalUpdateChange<string>;
  status?: ProposalUpdateChange<AgentSkillProposalStatus>;
};

const updateSkillProposal = createSafeRootHandler(
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
    if (
      body.body === undefined &&
      body.summary === undefined &&
      body.status === undefined
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "At least one field must be provided",
        }),
      );
    }

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
            body: agentSkillProposals.body,
            summary: agentSkillProposals.summary,
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
        if (isDecidedProposalStatus(existing.status)) {
          throw new HandlerError({
            status: 409,
            message: "Proposal has already been decided",
          });
        }

        const updates: ProposalUpdateFields = {};
        const changes: ProposalUpdateChanges = {};
        if (body.body !== undefined && body.body !== existing.body) {
          updates.body = body.body;
          changes.body = { old: existing.body, new: body.body };
        }
        if (body.summary !== undefined && body.summary !== existing.summary) {
          updates.summary = body.summary;
          changes.summary = { old: existing.summary, new: body.summary };
        }
        if (body.status !== undefined && body.status !== existing.status) {
          updates.status = body.status;
          changes.status = { old: existing.status, new: body.status };
        }
        if (Object.keys(updates).length === 0) {
          return;
        }

        await tx
          .update(agentSkillProposals)
          .set(updates)
          .where(eq(agentSkillProposals.id, existing.id));

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL,
          resourceId: existing.id,
          changes,
          metadata: { skillId: params.skillId },
        });
      }),
    );

    return Result.ok({ id: params.proposalId });
  },
);

export default updateSkillProposal;
