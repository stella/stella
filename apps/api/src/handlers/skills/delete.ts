import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkills } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteSkillParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const config = {
  permissions: { agentSkill: ["delete"] },
  params: deleteSkillParamsSchema,
} satisfies HandlerConfig;

const deleteSkill = createSafeRootHandler(
  config,
  async function* ({
    memberRole,
    params,
    request,
    safeDb,
    server,
    session,
    user,
  }) {
    const existingRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkills.id,
            scope: agentSkills.scope,
            userId: agentSkills.userId,
            slug: agentSkills.slug,
          })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.id, params.skillId),
              eq(agentSkills.organizationId, session.activeOrganizationId),
            ),
          )
          .limit(1),
      ),
    );
    const existing = existingRows.at(0);
    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Skill not found" }),
      );
    }

    if (
      existing.scope === "team" &&
      !["admin", "owner"].includes(memberRole.role)
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Only admins and owners can delete team skills",
        }),
      );
    }
    if (existing.scope === "private" && existing.userId !== user.id) {
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }

    yield* Result.await(
      safeDb(
        async (tx) =>
          await tx.transaction(async (innerTx) => {
            await innerTx
              .delete(agentSkills)
              .where(eq(agentSkills.id, params.skillId));

            await writeAuditLog(
              {
                ...createAuditContext({
                  organizationId: session.activeOrganizationId,
                  userId: user.id,
                  request,
                  server,
                }),
                action: AUDIT_ACTION.DELETE,
                resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
                resourceId: params.skillId,
                changes: {
                  deleted: {
                    old: { scope: existing.scope, slug: existing.slug },
                    new: null,
                  },
                },
              },
              innerTx,
            );
          }),
      ),
    );

    return Result.ok({ id: params.skillId });
  },
);

export default deleteSkill;
