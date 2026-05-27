import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const updateSkillResourceParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const updateSkillResourceBodySchema = t.Object({
  path: t.String({ minLength: 1, maxLength: 512 }),
  content: t.String(),
});

const config = {
  permissions: { agentSkill: ["update"] },
  params: updateSkillResourceParamsSchema,
  body: updateSkillResourceBodySchema,
} satisfies HandlerConfig;

const updateSkillResource = createSafeRootHandler(
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
            scope: agentSkills.scope,
            origin: agentSkills.origin,
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

    // `agentSkills.origin` is currently `"upload" | "url"` — both
    // are editable. Built-in skills live on disk, not in this table,
    // so there's nothing to gate here. If a future origin value is
    // added to the enum, TS will surface this site as non-exhaustive
    // and the gate can be re-added.

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

    const existingResourceRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkillResources.id,
            content: agentSkillResources.content,
            sizeBytes: agentSkillResources.sizeBytes,
            kind: agentSkillResources.kind,
            path: agentSkillResources.path,
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
    const existingResource = existingResourceRows.at(0);
    if (!existingResource) {
      return Result.err(
        new HandlerError({ status: 404, message: "Resource not found" }),
      );
    }

    const nextContent = body.content;
    const nextSizeBytes = new TextEncoder().encode(nextContent).byteLength;

    yield* Result.await(
      safeDb(
        async (tx) =>
          await tx.transaction(async (innerTx) => {
            await innerTx
              .update(agentSkillResources)
              .set({ content: nextContent, sizeBytes: nextSizeBytes })
              .where(eq(agentSkillResources.id, existingResource.id));

            await recordAuditEvent(innerTx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
              resourceId: params.skillId,
              changes: {
                resource: {
                  old: {
                    path: existingResource.path,
                    sizeBytes: existingResource.sizeBytes,
                  },
                  new: {
                    path: existingResource.path,
                    sizeBytes: nextSizeBytes,
                  },
                },
              },
              metadata: { slug: skill.slug, path: existingResource.path },
            });
          }),
      ),
    );

    return Result.ok({
      id: existingResource.id,
      skillId: params.skillId,
      path: existingResource.path,
      kind: existingResource.kind,
      content: nextContent,
      sizeBytes: nextSizeBytes,
    });
  },
);

export default updateSkillResource;
