import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { requireEditableSkillOrigin } from "../origin";

const deleteSkillResourceParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const deleteSkillResourceBodySchema = t.Object({
  path: t.String({ minLength: 1, maxLength: 512 }),
});

const config = {
  permissions: { agentSkill: ["update"] },
  params: deleteSkillResourceParamsSchema,
  body: deleteSkillResourceBodySchema,
} satisfies HandlerConfig;

const deleteSkillResource = createSafeRootHandler(
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
    const skillRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkills.id,
            origin: agentSkills.origin,
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
    const skill = skillRows.at(0);
    if (!skill) {
      return Result.err(
        new HandlerError({ status: 404, message: "Skill not found" }),
      );
    }

    if (
      skill.scope === "team" &&
      !["admin", "owner"].includes(memberRole.role)
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Only admins and owners can edit team skills",
        }),
      );
    }
    if (skill.scope === "private" && skill.userId !== user.id) {
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }
    const editableOrigin = requireEditableSkillOrigin(skill.origin);
    if (Result.isError(editableOrigin)) {
      return Result.err(editableOrigin.error);
    }

    const existingRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkillResources.id,
            path: agentSkillResources.path,
            sizeBytes: agentSkillResources.sizeBytes,
            kind: agentSkillResources.kind,
          })
          .from(agentSkillResources)
          .where(
            and(
              eq(agentSkillResources.skillId, params.skillId),
              eq(agentSkillResources.path, body.path),
            ),
          )
          .limit(1),
      ),
    );
    const existing = existingRows.at(0);
    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Resource not found" }),
      );
    }

    yield* Result.await(
      safeDb(
        async (tx) =>
          await tx.transaction(async (innerTx) => {
            await innerTx
              .delete(agentSkillResources)
              .where(eq(agentSkillResources.id, existing.id));

            await recordAuditEvent(innerTx, {
              action: AUDIT_ACTION.DELETE,
              resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
              resourceId: params.skillId,
              changes: {
                resource: {
                  old: {
                    path: existing.path,
                    kind: existing.kind,
                    sizeBytes: existing.sizeBytes,
                  },
                  new: null,
                },
              },
              metadata: { slug: skill.slug, path: existing.path },
            });
          }),
      ),
    );

    return Result.ok({ ok: true });
  },
);

export default deleteSkillResource;
