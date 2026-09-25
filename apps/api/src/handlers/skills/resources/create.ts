import { Result } from "better-result";
import { t } from "elysia";

import { SKILL_RESOURCE_KINDS } from "@stll/skills/resource-kinds";

import { agentSkillResources } from "@/api/db/schema";
import { loadSkillForNewResource } from "@/api/handlers/skills/resources/new-resource-skill";
import { refreshSkillContentHash } from "@/api/lib/agent-skills/content-hash";
import {
  RESOURCE_PATH_PATTERN,
  inferResourceKind,
} from "@/api/lib/agent-skills/resource-path";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const createSkillResourceParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const createSkillResourceBodySchema = t.Object({
  path: t.String({ minLength: 1, maxLength: 512 }),
  content: t.String({ maxLength: LIMITS.agentSkillResourceMaxChars }),
  kind: t.Optional(t.UnionEnum(SKILL_RESOURCE_KINDS)),
});

const config = {
  description:
    "Add one text file to an agent skill at a path such as " +
    "references/checklist.md, taking its kind from the path unless you pass " +
    "one. A path already used in the skill is a 409, a skill at its file " +
    "limit is refused, and bundled skills cannot be edited. Team skills " +
    "require admin or owner, private ones their author. Use " +
    "skills.resources.upload for a DOCX or PDF whose text must be extracted " +
    "first.",
  permissions: { agentSkill: ["update"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: createSkillResourceParamsSchema,
  body: createSkillResourceBodySchema,
} satisfies HandlerConfig;

const createSkillResource = createSafeRootHandler(
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
    const path = body.path.trim();
    if (!path || path.length > 512 || !RESOURCE_PATH_PATTERN.test(path)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid resource path" }),
      );
    }

    const skill = yield* Result.await(
      loadSkillForNewResource({
        safeDb,
        skillId: params.skillId,
        organizationId: session.activeOrganizationId,
        memberRole,
        userId: user.id,
        path,
      }),
    );

    const kind = body.kind ?? inferResourceKind(path);
    const sizeBytes = new TextEncoder().encode(body.content).byteLength;

    const inserted = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx.transaction(async (innerTx) => {
            const rows = await innerTx
              .insert(agentSkillResources)
              .values({
                organizationId: session.activeOrganizationId,
                skillId: params.skillId,
                path,
                kind,
                content: body.content,
                sizeBytes,
              })
              .returning({
                id: agentSkillResources.id,
                path: agentSkillResources.path,
                kind: agentSkillResources.kind,
                content: agentSkillResources.content,
                sizeBytes: agentSkillResources.sizeBytes,
              });
            await refreshSkillContentHash(innerTx, params.skillId);

            await recordAuditEvent(innerTx, {
              action: AUDIT_ACTION.CREATE,
              resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
              resourceId: params.skillId,
              changes: {
                resource: {
                  old: null,
                  new: { path, kind, sizeBytes },
                },
              },
              metadata: { slug: skill.slug, path },
            });

            return rows;
          }),
      ),
    );

    const row = inserted.at(0);
    if (!row) {
      return Result.err(
        new HandlerError({ status: 500, message: "Could not create file" }),
      );
    }

    return Result.ok({
      id: row.id,
      skillId: params.skillId,
      path: row.path,
      kind: row.kind,
      content: row.content,
      sizeBytes: row.sizeBytes,
    });
  },
);

export default createSkillResource;
