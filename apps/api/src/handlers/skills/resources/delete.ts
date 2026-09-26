import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkillResources } from "@/api/db/schema";
import { loadManagedSkill } from "@/api/handlers/skills/managed-skill";
import {
  lockSkillForResourceWrite,
  refreshSkillContentHash,
} from "@/api/lib/agent-skills/content-hash";
import { requireEditableSkillOrigin } from "@/api/lib/agent-skills/origin";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteSkillResourceParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const deleteSkillResourceBodySchema = t.Object({
  path: t.String({ minLength: 1, maxLength: 512 }),
});

const config = {
  description:
    "Delete one resource file from an agent skill, addressed by its path; the " +
    "skill and its other resources are untouched. Bundled skills are read-only " +
    "and are refused.",
  permissions: { agentSkill: ["update"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
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
            const lockedSkill = await lockSkillForResourceWrite(
              innerTx,
              params.skillId,
            );
            await innerTx
              .delete(agentSkillResources)
              .where(eq(agentSkillResources.id, existing.id));
            await refreshSkillContentHash(innerTx, lockedSkill);

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
