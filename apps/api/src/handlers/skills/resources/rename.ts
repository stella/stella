import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkillResources } from "@/api/db/schema";
import { loadManagedSkill } from "@/api/handlers/skills/managed-skill";
import { refreshSkillContentHash } from "@/api/lib/agent-skills/content-hash";
import { requireEditableSkillOrigin } from "@/api/lib/agent-skills/origin";
import {
  RESOURCE_PATH_PATTERN,
  inferResourceKind,
} from "@/api/lib/agent-skills/resource-path";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const renameSkillResourceParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const renameSkillResourceBodySchema = t.Object({
  oldPath: t.String({ minLength: 1, maxLength: 512 }),
  newPath: t.String({ minLength: 1, maxLength: 512 }),
});

const config = {
  description:
    "Move one file of an agent skill to a new path, re-deriving its kind " +
    "from that path and leaving the content untouched. A path identical to " +
    "the old one, a path already used by another file in the same skill, and " +
    "a bundled skill are all refused.",
  permissions: { agentSkill: ["update"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
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

    const skill = yield* Result.await(
      loadManagedSkill({
        safeDb,
        skillId: params.skillId,
        organizationId: session.activeOrganizationId,
        memberRole,
        userId: user.id,
        action: "edit",
      }),
    );
    yield* requireEditableSkillOrigin(skill.origin);

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
            await refreshSkillContentHash(innerTx, params.skillId);

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
