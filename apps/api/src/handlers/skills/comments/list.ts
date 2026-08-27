import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillComments } from "@/api/db/schema";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const listSkillCommentsParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const config = {
  description:
    "List the comments anchored to an agent skill, oldest first, across its " +
    "revisions and proposals. Each carries the character range and the quoted " +
    "text it was written against, and whether it has been resolved.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: listSkillCommentsParamsSchema,
} satisfies HandlerConfig;

const listSkillComments = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session }) {
    const items = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        return await tx
          .select({
            id: agentSkillComments.id,
            revisionId: agentSkillComments.revisionId,
            proposalId: agentSkillComments.proposalId,
            rangeStart: agentSkillComments.rangeStart,
            rangeEnd: agentSkillComments.rangeEnd,
            anchorText: agentSkillComments.anchorText,
            body: agentSkillComments.body,
            authorId: agentSkillComments.authorId,
            resolvedAt: agentSkillComments.resolvedAt,
            resolvedBy: agentSkillComments.resolvedBy,
            createdAt: agentSkillComments.createdAt,
          })
          .from(agentSkillComments)
          .where(
            and(
              eq(agentSkillComments.skillId, params.skillId),
              eq(
                agentSkillComments.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .orderBy(
            asc(agentSkillComments.createdAt),
            asc(agentSkillComments.id),
          )
          .limit(LIMITS.agentSkillCommentsPageSizeMax);
      }),
    );

    return Result.ok({ items });
  },
);

export default listSkillComments;
