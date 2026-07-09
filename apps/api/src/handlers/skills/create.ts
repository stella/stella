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

import { hashAuthoredSkillContent } from "./authored-content-hash";
import { authorizeSkillInstallScope } from "./install";
import { uniqueSlug } from "./slug";

const createSkillBodySchema = t.Object({
  scope: t.UnionEnum(AGENT_SKILL_SCOPES),
  name: t.String({ minLength: 1, maxLength: 64 }),
  description: t.String({
    minLength: 1,
    maxLength: LIMITS.agentSkillDescriptionMaxChars,
  }),
  body: t.String({ minLength: 1, maxLength: LIMITS.agentSkillBodyMaxChars }),
  command: t.Optional(t.String({ minLength: 1, maxLength: 50 })),
});

const config = {
  permissions: { agentSkill: ["create"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
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

    // Team skills are org-wide visible in the chat skill catalogue but are only
    // capped per-user above, so cap them per-org too: otherwise enough members
    // each authoring team skills can push the catalogue past
    // agentSkillsChatMetadataMax and silently hide the overflow from the model.
    if (body.scope === "team") {
      const teamCount = yield* Result.await(
        safeDb((tx) =>
          tx.$count(
            agentSkills,
            and(
              eq(agentSkills.organizationId, session.activeOrganizationId),
              eq(agentSkills.scope, "team"),
            ),
          ),
        ),
      );
      if (teamCount >= LIMITS.agentSkillsTeamPerOrganization) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Team skill limit reached for this organization",
          }),
        );
      }
    }

    const slug = uniqueSlug(body.name);

    const contentHash = hashAuthoredSkillContent({
      body: body.body,
      description: body.description,
      name: body.name,
      version: null,
    });

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
