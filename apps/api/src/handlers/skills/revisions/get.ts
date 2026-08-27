import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillRevisions } from "@/api/db/schema";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const getSkillRevisionParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
  revisionId: tSafeId("agentSkillRevision"),
});

const config = {
  description:
    "Read one recorded revision of an agent skill in full, including the " +
    "instruction body as it stood at that point.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: getSkillRevisionParamsSchema,
} satisfies HandlerConfig;

const getSkillRevision = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session }) {
    const revision = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        const rows = await tx
          .select({
            id: agentSkillRevisions.id,
            skillId: agentSkillRevisions.skillId,
            revisionNumber: agentSkillRevisions.revisionNumber,
            body: agentSkillRevisions.body,
            contentHash: agentSkillRevisions.contentHash,
            createdBy: agentSkillRevisions.createdBy,
            createdAt: agentSkillRevisions.createdAt,
            updatedAt: agentSkillRevisions.updatedAt,
          })
          .from(agentSkillRevisions)
          .where(
            and(
              eq(agentSkillRevisions.id, params.revisionId),
              eq(agentSkillRevisions.skillId, params.skillId),
              eq(
                agentSkillRevisions.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .limit(1);

        const row = rows.at(0);
        if (!row) {
          throw new HandlerError({
            status: 404,
            message: "Revision not found",
          });
        }

        return row;
      }),
    );

    return Result.ok(revision);
  },
);

export default getSkillRevision;
