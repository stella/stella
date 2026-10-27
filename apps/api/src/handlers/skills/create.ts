import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  AGENT_SKILL_COMMAND_PATTERN,
  AGENT_SKILL_SCOPES,
  agentSkills,
  RESERVED_AGENT_SKILL_COMMANDS,
} from "@/api/db/schema";
import { skillRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import {
  authorizeSkillBinding,
  skillBindingBodyFields,
} from "@/api/handlers/skills/skill-binding";
import { tSkillInvocation } from "@/api/handlers/skills/skill-invocation-schema";
import { hashSkillContent } from "@/api/lib/agent-skills/content-hash";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";
import { includes } from "@/api/lib/type-guards";

import { uniqueSlug } from "./slug";

const createSkillBodySchema = v.object({
  scope: v.picklist(AGENT_SKILL_SCOPES),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  description: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.agentSkillDescriptionMaxChars),
  ),
  body: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.agentSkillBodyMaxChars),
  ),
  command: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(50))),
  invocation: v.optional(tSkillInvocation()),
  ...skillBindingBodyFields,
});

const config = {
  contract: "patch",
  description:
    "Author an agent skill from text: name, description, instruction body, " +
    "an optional slash command, and an optional invocation (`auto`, the " +
    "default: the assistant may use it on its own; `manual`: only when the " +
    "user invokes it). Team scope requires admin or owner, " +
    "private scope is your own. Pass `boundWorkspaceId` to bind the skill " +
    "to one matter (any member who reaches the matter may, for team scope " +
    "too) or `boundClientId` to bind it to one client (admins and owners " +
    "only); a bound skill is visible and usable only there, and the binding " +
    "cannot change later. A command must be lowercase letters, digits, " +
    "hyphens, or underscores, must not be one of the reserved commands, and " +
    "must be free in the organization, as must the skill name. Refused once " +
    "the per-user or per-organization skill limit is reached. Use " +
    "skills.upload or skills.from-url.import for a packaged skill instead.",
  permissions: { agentSkill: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: skillRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
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
    const binding = {
      boundClientId: body.boundClientId ?? null,
      boundWorkspaceId: body.boundWorkspaceId ?? null,
    };
    yield* Result.await(
      authorizeSkillBinding({
        binding,
        memberRole,
        safeDb,
        scope: body.scope,
      }),
    );

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
      if (includes(RESERVED_AGENT_SKILL_COMMANDS, body.command)) {
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

    const contentHash = hashSkillContent({
      body: body.body,
      compatibility: null,
      description: body.description,
      license: null,
      metadata: {},
      name: body.name,
      resources: [],
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
          invocation: body.invocation ?? "auto",
          ...binding,
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
                ...(body.invocation !== undefined && {
                  invocation: body.invocation,
                }),
                ...(binding.boundWorkspaceId !== null && {
                  boundWorkspaceId: binding.boundWorkspaceId,
                }),
                ...(binding.boundClientId !== null && {
                  boundClientId: binding.boundClientId,
                }),
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
