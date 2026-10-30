import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { abortableTx } from "@/api/db/safe-db";
import {
  AGENT_SKILL_COMMAND_PATTERN,
  type AgentSkillInvocation,
  agentSkills,
  RESERVED_AGENT_SKILL_COMMANDS,
} from "@/api/db/schema";
import { skillRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { requireSkillManager } from "@/api/handlers/skills/managed-skill";
import { tSkillInvocation } from "@/api/handlers/skills/skill-invocation-schema";
import { uniqueSlug } from "@/api/handlers/skills/slug";
import type { SkillSlug } from "@/api/handlers/skills/slug";
import { auditedSkillBody } from "@/api/lib/agent-skills/audited-body";
import type { AuditedSkillBody } from "@/api/lib/agent-skills/audited-body";
import { skillContentHashAfter } from "@/api/lib/agent-skills/content-hash";
import { requireEditableSkillOrigin } from "@/api/lib/agent-skills/origin";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";
import { includes } from "@/api/lib/type-guards";

const updateSkillParamsSchema = v.object({
  skillId: resourceIdSchema("agentSkill"),
});

const updateSkillBodySchema = v.object({
  enabled: v.optional(v.boolean()),
  invocation: v.optional(tSkillInvocation()),
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  description: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(LIMITS.agentSkillDescriptionMaxChars),
    ),
  ),
  body: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(LIMITS.agentSkillBodyMaxChars),
    ),
  ),
  version: v.optional(
    v.union([
      v.pipe(v.string(), v.maxLength(LIMITS.agentSkillVersionMaxChars)),
      v.null(),
    ]),
  ),
  command: v.optional(
    v.union([v.pipe(v.string(), v.minLength(1), v.maxLength(50)), v.null()]),
  ),
});

const config = {
  contract: "replace",
  precondition: {
    type: "deferred",
    baselineId: "apps/api/src/handlers/skills/update.ts",
  },
  description:
    "Change an agent skill: enable or disable it, set its invocation (`auto`: " +
    "the assistant may use it on its own; `manual`: only when the user " +
    "invokes it), or edit its name, description, instruction body, version, " +
    "or slash command. Pass command as null to clear it; at least one field " +
    "is required. Enabling, disabling and the invocation work on any skill " +
    "you may manage, but editing the content of a bundled skill is refused. " +
    "A rename derives a new unique slug from the " +
    "name; a command already taken in the organization is a 409.",
  permissions: { agentSkill: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: skillRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
  params: updateSkillParamsSchema,
  body: updateSkillBodySchema,
} satisfies HandlerConfig;

type SkillUpdateFields = {
  body?: string;
  contentHash?: string;
  description?: string;
  enabled?: boolean;
  invocation?: AgentSkillInvocation;
  name?: string;
  slug?: SkillSlug;
  version?: string | null;
  command?: string | null;
};

type SkillUpdateChange<T> = { old: T; new: T };

type SkillUpdateChanges = {
  body?: SkillUpdateChange<AuditedSkillBody>;
  description?: SkillUpdateChange<string>;
  enabled?: SkillUpdateChange<boolean>;
  invocation?: SkillUpdateChange<AgentSkillInvocation>;
  name?: SkillUpdateChange<string>;
  slug?: SkillUpdateChange<string>;
  version?: SkillUpdateChange<string | null>;
  command?: SkillUpdateChange<string | null>;
};

type SkillUpdateExisting = {
  body: string;
  description: string;
  enabled: boolean;
  invocation: AgentSkillInvocation;
  name: string;
  slug: string;
  version: string | null;
  command: string | null;
};

type SkillUpdateBody = {
  enabled?: boolean | undefined;
  invocation?: AgentSkillInvocation | undefined;
  name?: string | undefined;
  description?: string | undefined;
  body?: string | undefined;
  version?: string | null | undefined;
  command?: string | null | undefined;
};

type SkillUpdateDiff = {
  updates: SkillUpdateFields;
  changes: SkillUpdateChanges;
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
  if (includes(RESERVED_AGENT_SKILL_COMMANDS, command)) {
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
  if (
    body.invocation !== undefined &&
    body.invocation !== existing.invocation
  ) {
    updates.invocation = body.invocation;
    changes.invocation = { old: existing.invocation, new: body.invocation };
  }
  if (body.name !== undefined && body.name !== existing.name) {
    const slug = uniqueSlug(body.name);
    updates.name = body.name;
    updates.slug = slug;
    changes.name = { old: existing.name, new: body.name };
    changes.slug = { old: existing.slug, new: slug };
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
    changes.body = {
      old: auditedSkillBody(existing.body),
      new: auditedSkillBody(body.body),
    };
  }
  if (body.version !== undefined && body.version !== existing.version) {
    updates.version = body.version;
    changes.version = { old: existing.version, new: body.version };
  }
  if (body.command !== undefined && body.command !== existing.command) {
    updates.command = body.command;
    changes.command = { old: existing.command, new: body.command };
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
      body.command !== undefined;
    if (
      body.enabled === undefined &&
      body.invocation === undefined &&
      !hasMetadataEdit
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "At least one field must be provided",
        }),
      );
    }

    yield* validateRequestedCommand(body.command);

    // Read, decide, and write under one row lock: the diff, the audit's old
    // values, and the content hash all derive from the row being replaced.
    // Every refusal is decided before the first write, so returning it
    // commits nothing.
    const updateResult = await abortableTx(
      safeDb,
      async (tx): Promise<Result<void, HandlerError>> => {
        const existingRows = await tx
          .select({
            id: agentSkills.id,
            scope: agentSkills.scope,
            userId: agentSkills.userId,
            boundClientId: agentSkills.boundClientId,
            boundWorkspaceId: agentSkills.boundWorkspaceId,
            enabled: agentSkills.enabled,
            invocation: agentSkills.invocation,
            slug: agentSkills.slug,
            name: agentSkills.name,
            description: agentSkills.description,
            body: agentSkills.body,
            version: agentSkills.version,
            origin: agentSkills.origin,
            command: agentSkills.command,
          })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.id, params.skillId),
              eq(agentSkills.organizationId, session.activeOrganizationId),
            ),
          )
          .limit(1)
          .for("update");
        const existing = existingRows.at(0);
        if (!existing) {
          // The row lock follows the write policy, so a skill the caller can
          // read but not manage is missing here; refuse it as the handler would.
          const visibleRows = await tx
            .select({
              boundClientId: agentSkills.boundClientId,
              boundWorkspaceId: agentSkills.boundWorkspaceId,
              scope: agentSkills.scope,
              userId: agentSkills.userId,
            })
            .from(agentSkills)
            .where(
              and(
                eq(agentSkills.id, params.skillId),
                eq(agentSkills.organizationId, session.activeOrganizationId),
              ),
            )
            .limit(1);
          const visible = visibleRows.at(0);
          if (!visible) {
            return Result.err(
              new HandlerError({ status: 404, message: "Skill not found" }),
            );
          }
          const refused = requireSkillManager({
            skill: visible,
            memberRole,
            userId: user.id,
            action: "edit",
          });
          if (Result.isError(refused)) {
            return refused;
          }
          panic(
            "skills.update: the write policy hid a skill the caller manages",
          );
        }

        const manager = requireSkillManager({
          skill: existing,
          memberRole,
          userId: user.id,
          action: "edit",
        });
        if (Result.isError(manager)) {
          return manager;
        }
        if (hasMetadataEdit) {
          const editable = requireEditableSkillOrigin(existing.origin);
          if (Result.isError(editable)) {
            return editable;
          }
        }

        const { updates, changes } = buildSkillUpdateDiff(body, existing);
        if (Object.keys(updates).length === 0) {
          return Result.ok(undefined);
        }

        if (
          updates.body !== undefined ||
          updates.description !== undefined ||
          updates.name !== undefined ||
          updates.version !== undefined
        ) {
          updates.contentHash = await skillContentHashAfter(tx, {
            skillId: params.skillId,
            patch: updates,
          });
        }

        await tx
          .update(agentSkills)
          .set(updates)
          .where(eq(agentSkills.id, params.skillId));

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
          resourceId: params.skillId,
          changes,
          metadata: { slug: updates.slug ?? existing.slug },
        });
        return Result.ok(undefined);
      },
    );
    if (Result.isError(updateResult)) {
      if (
        DatabaseError.is(updateResult.error) &&
        updateResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        if (typeof body.command === "string") {
          return Result.err(
            new HandlerError({
              status: 409,
              message: `A skill with command "/${body.command}" already exists`,
            }),
          );
        }
        return Result.err(
          new HandlerError({
            status: 409,
            message: "A skill with the same name already exists",
          }),
        );
      }
      return Result.err(updateResult.error);
    }
    yield* updateResult.value;

    return Result.ok({ id: params.skillId });
  },
);

export default updateSkill;
