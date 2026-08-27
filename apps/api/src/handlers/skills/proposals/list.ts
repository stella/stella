import { panic, Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillProposals } from "@/api/db/schema";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { loadLatestSkillRevision } from "@/api/lib/agent-skills/revisions";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const listSkillProposalsParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const config = {
  description:
    "List the change proposals raised against an agent skill, newest first " +
    "and without their bodies. baseIsCurrent " +
    "reports whether a proposal still branches from the skill's newest " +
    "revision.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: listSkillProposalsParamsSchema,
} satisfies HandlerConfig;

const listSkillProposals = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session }) {
    const items = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        const latestRevision = await loadLatestSkillRevision(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });
        if (!latestRevision) {
          panic("agent skill has no revision");
        }

        const rows = await tx
          .select({
            id: agentSkillProposals.id,
            baseRevisionId: agentSkillProposals.baseRevisionId,
            summary: agentSkillProposals.summary,
            status: agentSkillProposals.status,
            authorId: agentSkillProposals.authorId,
            reviewerId: agentSkillProposals.reviewerId,
            decidedAt: agentSkillProposals.decidedAt,
            resultRevisionId: agentSkillProposals.resultRevisionId,
            createdAt: agentSkillProposals.createdAt,
            updatedAt: agentSkillProposals.updatedAt,
          })
          .from(agentSkillProposals)
          .where(
            and(
              eq(agentSkillProposals.skillId, params.skillId),
              eq(
                agentSkillProposals.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .orderBy(
            desc(agentSkillProposals.createdAt),
            desc(agentSkillProposals.id),
          )
          .limit(LIMITS.agentSkillProposalsPageSizeMax);

        return rows.map((row) => ({
          id: row.id,
          baseRevisionId: row.baseRevisionId,
          baseIsCurrent: row.baseRevisionId === latestRevision.id,
          summary: row.summary,
          status: row.status,
          authorId: row.authorId,
          reviewerId: row.reviewerId,
          decidedAt: row.decidedAt,
          resultRevisionId: row.resultRevisionId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }));
      }),
    );

    return Result.ok({ items });
  },
);

export default listSkillProposals;
