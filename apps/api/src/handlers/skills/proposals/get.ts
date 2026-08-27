import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillProposals, agentSkillRevisions } from "@/api/db/schema";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { loadLatestSkillRevision } from "@/api/lib/agent-skills/revisions";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const getSkillProposalParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
  proposalId: tSafeId("agentSkillProposal"),
});

const config = {
  description:
    "Read one change proposal for an agent skill, with its proposed body and " +
    "the body of the revision it branched from, so the two can be diffed.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: getSkillProposalParamsSchema,
} satisfies HandlerConfig;

const getSkillProposal = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session }) {
    const proposal = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        const rows = await tx
          .select({
            id: agentSkillProposals.id,
            skillId: agentSkillProposals.skillId,
            baseRevisionId: agentSkillProposals.baseRevisionId,
            body: agentSkillProposals.body,
            summary: agentSkillProposals.summary,
            status: agentSkillProposals.status,
            authorId: agentSkillProposals.authorId,
            reviewerId: agentSkillProposals.reviewerId,
            decidedAt: agentSkillProposals.decidedAt,
            resultRevisionId: agentSkillProposals.resultRevisionId,
            createdAt: agentSkillProposals.createdAt,
            updatedAt: agentSkillProposals.updatedAt,
            baseBody: agentSkillRevisions.body,
          })
          .from(agentSkillProposals)
          .innerJoin(
            agentSkillRevisions,
            eq(agentSkillRevisions.id, agentSkillProposals.baseRevisionId),
          )
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

        const row = rows.at(0);
        if (!row) {
          throw new HandlerError({
            status: 404,
            message: "Proposal not found",
          });
        }

        const latest = await loadLatestSkillRevision(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });
        return { ...row, baseIsCurrent: latest?.id === row.baseRevisionId };
      }),
    );

    return Result.ok(proposal);
  },
);

export default getSkillProposal;
