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
import { RESOURCE_PATH_PATTERN, inferResourceKind } from "./resource-path";

const renameSkillResourceParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const renameSkillResourceBodySchema = t.Object({
  oldPath: t.String({ minLength: 1, maxLength: 512 }),
  newPath: t.String({ minLength: 1, maxLength: 512 }),
});

const config = {
  permissions: { agentSkill: ["update"] },
  params: renameSkillResourceParamsSchema,
  body: renameSkillResourceBodySchema,
} satisfies HandlerConfig;

const renameSkillResource = createSafeRootHandler(
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
    const newPath = body.newPath.trim();
    if (!newPath || !RESOURCE_PATH_PATTERN.test(newPath)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid resource path" }),
      );
    }
    if (newPath === body.oldPath) {
      return Result.err(
        new HandlerError({ status: 400, message: "Paths are identical" }),
      );
    }

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
            kind: agentSkillResources.kind,
            sizeBytes: agentSkillResources.sizeBytes,
            content: agentSkillResources.content,
          })
          .from(agentSkillResources)
          .where(
            and(
              eq(agentSkillResources.skillId, params.skillId),
              eq(agentSkillResources.path, body.oldPath),
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

    const collisionRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: agentSkillResources.id })
          .from(agentSkillResources)
          .where(
            and(
              eq(agentSkillResources.skillId, params.skillId),
              eq(agentSkillResources.path, newPath),
            ),
          )
          .limit(1),
      ),
    );
    if (collisionRows.length > 0) {
      return Result.err(
        new HandlerError({ status: 409, message: "File already exists" }),
      );
    }

    const nextKind = inferResourceKind(newPath);

    yield* Result.await(
      safeDb(
        async (tx) =>
          await tx.transaction(async (innerTx) => {
            await innerTx
              .update(agentSkillResources)
              .set({ path: newPath, kind: nextKind })
              .where(eq(agentSkillResources.id, existing.id));

            await recordAuditEvent(innerTx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
              resourceId: params.skillId,
              changes: {
                resource: {
                  old: { path: existing.path, kind: existing.kind },
                  new: { path: newPath, kind: nextKind },
                },
              },
              metadata: {
                slug: skill.slug,
                oldPath: existing.path,
                newPath,
              },
            });
          }),
      ),
    );

    return Result.ok({
      id: existing.id,
      skillId: params.skillId,
      path: newPath,
      kind: nextKind,
      content: existing.content,
      sizeBytes: existing.sizeBytes,
    });
  },
);

export default renameSkillResource;
