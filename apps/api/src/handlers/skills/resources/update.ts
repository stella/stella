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
import { LIMITS } from "@/api/lib/limits";

const updateSkillResourceParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const updateSkillResourceBodySchema = t.Object({
  path: t.String({ minLength: 1, maxLength: 512 }),
  content: t.String({ maxLength: LIMITS.agentSkillResourceMaxChars }),
});

const config = {
  description:
    "Replace the content of one file of an agent skill, addressed by its " +
    "path. The path and kind stay as they are; use skills.resources.rename " +
    "to change them. Bundled skills are read-only, team skills require admin " +
    "or owner, and private ones their author.",
  permissions: { agentSkill: ["update"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
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
            const lockedSkill = await lockSkillForResourceWrite(
              innerTx,
              params.skillId,
            );
            await innerTx
              .update(agentSkillResources)
              .set({ content: nextContent, sizeBytes: nextSizeBytes })
              .where(eq(agentSkillResources.id, existingResource.id));
            await refreshSkillContentHash(innerTx, lockedSkill);

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
