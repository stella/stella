import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillRevisions } from "@/api/db/schema";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const listSkillRevisionsParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const config = {
  description:
    "List the recorded revisions of an agent skill, newest first, without " +
    "their bodies. Every body change records one, including the edits that " +
    "accepting a proposal makes.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: listSkillRevisionsParamsSchema,
} satisfies HandlerConfig;

const listSkillRevisions = createSafeRootHandler(
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
            id: agentSkillRevisions.id,
            revisionNumber: agentSkillRevisions.revisionNumber,
            contentHash: agentSkillRevisions.contentHash,
            createdBy: agentSkillRevisions.createdBy,
            createdAt: agentSkillRevisions.createdAt,
            updatedAt: agentSkillRevisions.updatedAt,
          })
          .from(agentSkillRevisions)
          .where(
            and(
              eq(agentSkillRevisions.skillId, params.skillId),
              eq(
                agentSkillRevisions.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .orderBy(desc(agentSkillRevisions.revisionNumber))
          .limit(LIMITS.agentSkillRevisionsPageSizeMax);
      }),
    );

    return Result.ok({ items });
  },
);

export default listSkillRevisions;
