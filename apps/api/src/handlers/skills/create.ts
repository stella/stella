import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  AGENT_SKILL_COMMAND_PATTERN,
  AGENT_SKILL_SCOPES,
  RESERVED_AGENT_SKILL_COMMANDS,
  agentSkills,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";

import { authorizeSkillInstallScope } from "./install";

// Authored skills don't ship with a pre-validated slug — derive one
// from the name so the rest of the skills surface (uniqueness,
// references) keeps working unchanged. Trim invalid chars, collapse
// runs of hyphens, and clip to fit the `slug` column.
const slugify = (name: string): string => {
  // Plain character-by-character pass — the previous regex pipeline
  // tripped the slow-regex lint, and a single-pass loop is also
  // easier to reason about. Collapse runs of non-slug chars into a
  // single hyphen, then trim leading/trailing hyphens.
  let buffer = "";
  let lastWasSeparator = true;
  for (const ch of name.toLowerCase()) {
    const isSlugChar = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (isSlugChar) {
      buffer += ch;
      lastWasSeparator = false;
      continue;
    }
    if (!lastWasSeparator) {
      buffer += "-";
      lastWasSeparator = true;
    }
  }
  while (buffer.endsWith("-")) {
    buffer = buffer.slice(0, -1);
  }
  if (buffer.length === 0) {
    return "skill";
  }
  return buffer.slice(0, 56);
};

// Stable-ish suffix to break (org, scope, slug) collisions without
// requiring a server-side counter. Date-encoded so users can spot the
// authored-on timestamp at a glance in the URL.
const collisionSuffix = (): string => Date.now().toString(36).slice(-7);

const createSkillBodySchema = t.Object({
  scope: t.UnionEnum(AGENT_SKILL_SCOPES),
  name: t.String({ minLength: 1, maxLength: 64 }),
  description: t.String({
    minLength: 1,
    maxLength: LIMITS.agentSkillDescriptionMaxChars,
  }),
  body: t.String({ minLength: 1, maxLength: LIMITS.agentSkillBodyMaxChars }),
  command: t.Optional(t.String({ minLength: 1, maxLength: 50 })),
  autoInvokeHint: t.Optional(t.String({ maxLength: 2000 })),
});

const config = {
  permissions: { agentSkill: ["create"] },
  body: createSkillBodySchema,
} satisfies HandlerConfig;

const createSkill = createSafeRootHandler(
  config,
  async function* ({
    body,
    memberRole,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const authorization = authorizeSkillInstallScope({
      memberRole,
      scope: body.scope,
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }

    if (body.command !== undefined) {
      if (!AGENT_SKILL_COMMAND_PATTERN.test(body.command)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "Command must start with a letter or digit and contain only lowercase letters, digits, hyphens, and underscores",
          }),
        );
      }
      if (
        (RESERVED_AGENT_SKILL_COMMANDS as readonly string[]).includes(
          body.command,
        )
      ) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: `"/${body.command}" is a reserved command`,
          }),
        );
      }
    }

    const userCount = yield* Result.await(
      safeDb((tx) =>
        tx.$count(
          agentSkills,
          and(
            eq(agentSkills.organizationId, session.activeOrganizationId),
            eq(agentSkills.userId, user.id),
          ),
        ),
      ),
    );
    if (userCount >= LIMITS.agentSkillsPerUser) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Skill limit reached for this user",
        }),
      );
    }

    const baseSlug = slugify(body.name);
    const slug = `${baseSlug}-${collisionSuffix()}`.slice(0, 64);

    // contentHash is an integrity marker; for authored skills it
    // derives from the body so future edits change the hash.
    const contentHash = new Bun.CryptoHasher("sha256")
      .update(body.body)
      .digest("hex")
      .slice(0, 64);

    const trimmedHint = body.autoInvokeHint?.trim();
    const autoInvokeHint =
      trimmedHint !== undefined && trimmedHint.length > 0 ? trimmedHint : null;

    const insertResult = await safeDb(async (tx) => {
      const rows = await tx
        .insert(agentSkills)
        .values({
          organizationId: session.activeOrganizationId,
          userId: user.id,
          scope: body.scope,
          origin: "authored",
          slug,
          name: body.name,
          description: body.description,
          metadata: {},
          contentHash,
          body: body.body,
          enabled: true,
          command: body.command ?? null,
          autoInvokeHint,
        })
        .returning({ id: agentSkills.id });

      const row = rows.at(0);
      if (row) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
          resourceId: row.id,
          changes: {
            created: {
              old: null,
              new: {
                scope: body.scope,
                slug,
                origin: "authored",
                ...(body.command !== undefined && { command: body.command }),
                ...(autoInvokeHint !== null && { hasAutoInvokeHint: true }),
              },
            },
          },
        });
      }

      return rows;
    });

    if (Result.isError(insertResult)) {
      if (
        DatabaseError.is(insertResult.error) &&
        insertResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        if (body.command !== undefined) {
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
      return Result.err(insertResult.error);
    }

    const row = insertResult.value.at(0);
    if (!row) {
      panic("Failed to create authored skill");
    }

    return Result.ok({ id: row.id });
  },
);

export default createSkill;
