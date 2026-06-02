import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  AGENT_SKILL_COMMAND_PATTERN,
  RESERVED_AGENT_SKILL_COMMANDS,
  agentSkills,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";

import { requireEditableSkillOrigin } from "./origin";

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const updateSkillParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const updateSkillBodySchema = t.Object({
  enabled: t.Optional(t.Boolean()),
  name: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
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
  // Optional slash-command handle. Pass `null` to clear an existing
  // command; pass a string to set/replace it. Omitting the field
  // leaves it untouched.
  command: t.Optional(
    t.Union([t.String({ minLength: 1, maxLength: 50 }), t.Null()]),
  ),
  // Optional auto-invocation hint. Same null-vs-undefined semantics
  // as `command`.
  autoInvokeHint: t.Optional(
    t.Union([t.String({ maxLength: 2000 }), t.Null()]),
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
  slug?: string;
  version?: string | null;
  command?: string | null;
  autoInvokeHint?: string | null;
};

type SkillUpdateChange<T> = { old: T; new: T };

type SkillUpdateChanges = {
  body?: SkillUpdateChange<string>;
  description?: SkillUpdateChange<string>;
  enabled?: SkillUpdateChange<boolean>;
  name?: SkillUpdateChange<string>;
  slug?: SkillUpdateChange<string>;
  version?: SkillUpdateChange<string | null>;
  command?: SkillUpdateChange<string | null>;
  autoInvokeHint?: SkillUpdateChange<string | null>;
};

type SkillUpdateExisting = {
  body: string;
  description: string;
  enabled: boolean;
  name: string;
  slug: string;
  version: string | null;
  command: string | null;
  autoInvokeHint: string | null;
};

type SkillUpdateBody = {
  enabled?: boolean | undefined;
  name?: string | undefined;
  description?: string | undefined;
  body?: string | undefined;
  version?: string | null | undefined;
  command?: string | null | undefined;
  autoInvokeHint?: string | null | undefined;
};

type SkillUpdateDiff = {
  updates: SkillUpdateFields;
  changes: SkillUpdateChanges;
};

const normaliseAutoInvokeHint = (
  value: string | null | undefined,
): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const validateRequestedCommand = (
  command: string | null | undefined,
): Result<void, HandlerError> => {
  if (typeof command !== "string") {
    return Result.ok(undefined);
  }
  if (!AGENT_SKILL_COMMAND_PATTERN.test(command)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "Command must start with a letter or digit and contain only lowercase letters, digits, hyphens, and underscores",
      }),
    );
  }
  if ((RESERVED_AGENT_SKILL_COMMANDS as readonly string[]).includes(command)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `"/${command}" is a reserved command`,
      }),
    );
  }
  return Result.ok(undefined);
};

const buildSkillUpdateDiff = (
  body: SkillUpdateBody,
  existing: SkillUpdateExisting,
): SkillUpdateDiff => {
  const updates: SkillUpdateFields = {};
  const changes: SkillUpdateChanges = {};

  if (body.enabled !== undefined && body.enabled !== existing.enabled) {
    updates.enabled = body.enabled;
    changes.enabled = { old: existing.enabled, new: body.enabled };
  }
  if (body.name !== undefined && body.name !== existing.name) {
    updates.name = body.name;
    updates.slug = body.name;
    changes.name = { old: existing.name, new: body.name };
    changes.slug = { old: existing.slug, new: body.name };
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
  if (body.command !== undefined && body.command !== existing.command) {
    updates.command = body.command;
    changes.command = { old: existing.command, new: body.command };
  }
  const nextHint = normaliseAutoInvokeHint(body.autoInvokeHint);
  if (nextHint !== undefined && nextHint !== existing.autoInvokeHint) {
    updates.autoInvokeHint = nextHint;
    changes.autoInvokeHint = {
      old: existing.autoInvokeHint,
      new: nextHint,
    };
  }

  return { updates, changes };
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
      body.version !== undefined ||
      body.command !== undefined ||
      body.autoInvokeHint !== undefined;
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

    const commandValidation = validateRequestedCommand(body.command);
    if (Result.isError(commandValidation)) {
      return Result.err(commandValidation.error);
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
            command: agentSkills.command,
            autoInvokeHint: agentSkills.autoInvokeHint,
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

    if (hasMetadataEdit) {
      const editableOrigin = requireEditableSkillOrigin(existing.origin);
      if (Result.isError(editableOrigin)) {
        return Result.err(editableOrigin.error);
      }
    }

    const { updates, changes } = buildSkillUpdateDiff(body, existing);

    if (Object.keys(updates).length === 0) {
      return Result.ok({ id: params.skillId });
    }

    // TODO(skills-editor): when body/name/description/version change, recompute
    // contentHash. The current hash is derived from the raw SKILL.md source
    // (frontmatter + body) plus resources via hashSkillPackage in
    // skill-package.ts; reusing it requires reconstructing the frontmatter from
    // stored columns. Leaving the existing hash in place until per-resource
    // editing lands so the hash stays consistent across editable surfaces.

    const updateResult = await safeDb(
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
            metadata: { slug: updates.slug ?? existing.slug },
          });
        }),
    );
    if (Result.isError(updateResult)) {
      if (
        DatabaseError.is(updateResult.error) &&
        updateResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        if (typeof updates.command === "string") {
          return Result.err(
            new HandlerError({
              status: 409,
              message: `A skill with command "/${updates.command}" already exists`,
            }),
          );
        }
        return Result.err(
          new HandlerError({
            status: 409,
            message: `A skill named "${updates.slug ?? existing.slug}" already exists`,
          }),
        );
      }
      return Result.err(updateResult.error);
    }

    return Result.ok({ id: params.skillId });
  },
);

export default updateSkill;
