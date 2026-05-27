import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkills } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const updateSkillParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const updateSkillBodySchema = t.Object({
  enabled: t.Optional(t.Boolean()),
  name: t.Optional(
    t.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]*$" }),
  ),
  description: t.Optional(
    t.String({ minLength: 1, maxLength: LIMITS.agentSkillDescriptionMaxChars }),
  ),
  body: t.Optional(
    t.String({ minLength: 1, maxLength: LIMITS.agentSkillBodyMaxChars }),
  ),
  version: t.Optional(
    t.Union([
      t.String({ maxLength: LIMITS.agentSkillVersionMaxChars }),
      t.Null(),
    ]),
  ),
});

const config = {
  permissions: { agentSkill: ["update"] },
  params: updateSkillParamsSchema,
  body: updateSkillBodySchema,
} satisfies HandlerConfig;

type SkillUpdateFields = {
  body?: string;
  description?: string;
  enabled?: boolean;
  name?: string;
  version?: string | null;
};

type SkillUpdateChange<T> = { old: T; new: T };

type SkillUpdateChanges = {
  body?: SkillUpdateChange<string>;
  description?: SkillUpdateChange<string>;
  enabled?: SkillUpdateChange<boolean>;
  name?: SkillUpdateChange<string>;
  version?: SkillUpdateChange<string | null>;
};

const updateSkill = createSafeRootHandler(
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
    const hasMetadataEdit =
      body.name !== undefined ||
      body.description !== undefined ||
      body.body !== undefined ||
      body.version !== undefined;
    if (body.enabled === undefined && !hasMetadataEdit) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "At least one field must be provided",
        }),
      );
    }

    if (body.name !== undefined && !SKILL_NAME_PATTERN.test(body.name)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Skill name must use lowercase letters, digits, and hyphens only",
        }),
      );
    }

    const existingRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkills.id,
            scope: agentSkills.scope,
            userId: agentSkills.userId,
            enabled: agentSkills.enabled,
            slug: agentSkills.slug,
            name: agentSkills.name,
            description: agentSkills.description,
            body: agentSkills.body,
            version: agentSkills.version,
            origin: agentSkills.origin,
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
          message: "Only admins and owners can edit team skills",
        }),
      );
    }
    if (existing.scope === "private" && existing.userId !== user.id) {
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }

    // Defensive: built-in skills are not stored in the database today (their
    // `origin` union is currently "upload" | "url"). If a future schema change
    // ever persists built-ins with a third origin, this branch will start
    // catching them before they can be mutated through this endpoint.
    const editableOrigins: readonly string[] = ["upload", "url"];
    if (hasMetadataEdit && !editableOrigins.includes(existing.origin)) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Built-in skills cannot be edited",
        }),
      );
    }

    const updates: SkillUpdateFields = {};
    const changes: SkillUpdateChanges = {};

    if (body.enabled !== undefined && body.enabled !== existing.enabled) {
      updates.enabled = body.enabled;
      changes.enabled = { old: existing.enabled, new: body.enabled };
    }
    if (body.name !== undefined && body.name !== existing.name) {
      updates.name = body.name;
      changes.name = { old: existing.name, new: body.name };
    }
    if (
      body.description !== undefined &&
      body.description !== existing.description
    ) {
      updates.description = body.description;
      changes.description = {
        old: existing.description,
        new: body.description,
      };
    }
    if (body.body !== undefined && body.body !== existing.body) {
      updates.body = body.body;
      changes.body = { old: existing.body, new: body.body };
    }
    if (body.version !== undefined && body.version !== existing.version) {
      updates.version = body.version;
      changes.version = { old: existing.version, new: body.version };
    }

    if (Object.keys(updates).length === 0) {
      return Result.ok({ id: params.skillId });
    }

    // TODO(skills-editor): when body/name/description/version change, recompute
    // contentHash. The current hash is derived from the raw SKILL.md source
    // (frontmatter + body) plus resources via hashSkillPackage in
    // skill-package.ts; reusing it requires reconstructing the frontmatter from
    // stored columns. Leaving the existing hash in place until per-resource
    // editing lands so the hash stays consistent across editable surfaces.

    yield* Result.await(
      safeDb(
        async (tx) =>
          await tx.transaction(async (innerTx) => {
            await innerTx
              .update(agentSkills)
              .set(updates)
              .where(eq(agentSkills.id, params.skillId));

            await recordAuditEvent(innerTx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
              resourceId: params.skillId,
              changes,
              metadata: { slug: existing.slug },
            });
          }),
      ),
    );

    return Result.ok({ id: params.skillId });
  },
);

export default updateSkill;
