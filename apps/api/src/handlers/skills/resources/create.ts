import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkillResources, agentSkills } from "@/api/db/schema";
import type { AgentSkillResourceKind } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import { RESOURCE_PATH_PATTERN, inferResourceKind } from "./resource-path";

const createSkillResourceParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const createSkillResourceBodySchema = t.Object({
  path: t.String({ minLength: 1, maxLength: 512 }),
  content: t.String({ maxLength: LIMITS.agentSkillResourceMaxChars }),
  kind: t.Optional(
    t.Union([
      t.Literal("asset"),
      t.Literal("knowledge"),
      t.Literal("prompt"),
      t.Literal("reference"),
      t.Literal("script"),
      t.Literal("template"),
    ]),
  ),
});

const config = {
  permissions: { agentSkill: ["update"] },
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

    const skillRows = yield* Result.await(
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

    const existingCount = yield* Result.await(
      safeDb((tx) =>
        tx.$count(
          agentSkillResources,
          eq(agentSkillResources.skillId, params.skillId),
        ),
      ),
    );
    if (existingCount >= LIMITS.agentSkillResourcesPerSkill) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Skill has reached the maximum number of files",
        }),
      );
    }

    const duplicateRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: agentSkillResources.id })
          .from(agentSkillResources)
          .where(
            and(
              eq(agentSkillResources.skillId, params.skillId),
              eq(agentSkillResources.path, path),
            ),
          )
          .limit(1),
      ),
    );
    if (duplicateRows.length > 0) {
      return Result.err(
        new HandlerError({ status: 409, message: "File already exists" }),
      );
    }

    const kind: AgentSkillResourceKind = body.kind ?? inferResourceKind(path);
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
