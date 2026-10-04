import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkills } from "@/api/db/schema";
import { skillRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { loadManagedSkill } from "@/api/handlers/skills/managed-skill";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";

const deleteSkillParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const config = {
  description:
    "Permanently delete an agent skill from the organization, with every " +
    "resource file attached to it. Team skills may only be deleted by an admin " +
    "or owner and private skills only by their author; bundled skills, which " +
    "cannot be edited, can still be deleted here.",
  permissions: { agentSkill: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: skillRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
  params: deleteSkillParamsSchema,
} satisfies HandlerConfig;

const deleteSkill = createSafeRootHandler(
  config,
  async function* ({
    memberRole,
    params,
    safeDb,
    session,
    user,
    recordAuditEvent,
  }) {
    const existing = yield* Result.await(
      loadManagedSkill({
        safeDb,
        skillId: params.skillId,
        organizationId: session.activeOrganizationId,
        memberRole,
        userId: user.id,
        action: "delete",
      }),
    );

    yield* Result.await(
      safeDb(
        async (tx) =>
          await tx.transaction(async (innerTx) => {
            await innerTx
              .delete(agentSkills)
              .where(eq(agentSkills.id, params.skillId));

            await recordAuditEvent(innerTx, {
              action: AUDIT_ACTION.DELETE,
              resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
              resourceId: params.skillId,
              changes: {
                deleted: {
                  old: { scope: existing.scope, slug: existing.slug },
                  new: null,
                },
              },
            });
          }),
      ),
    );

    return Result.ok({ id: params.skillId });
  },
);

export default deleteSkill;
