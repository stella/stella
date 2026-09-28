import { Result } from "better-result";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";

import { AGENT_SKILL_SCOPES, agentSkills } from "@/api/db/schema";
import { resolveCallerChatSkillAvailability } from "@/api/handlers/skills/chat-availability";
import { SKILL_TOOL_AVAILABILITY_STATUS } from "@/api/lib/agent-skills/required-tools";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

// Returns the subset of skills that carry a slash-command handle,
// shaped for the chat composer's slash menu, leaving out a skill that
// needs a tool chat does not have. Distinct from the
// general `/skills` listing because:
//   1. it always includes `body` (the slash menu inserts it into
//      the composer on pick), which the regular listing intentionally
//      omits to keep the catalogue payload lean
//   2. the result is small (one row per command, capped at 250) so
//      the menu doesn't need pagination
//   3. its cache key is independent so editor mutations don't blow
//      away unrelated catalogue/inspector reads
const config = {
  description:
    "List the enabled skills that carry a slash command, shaped for the chat " +
    "composer's command menu: id, scope, name, description, command, and the " +
    "full instruction body to insert on pick. Capped at 250 rows and not " +
    "paginated; use skills.list for the whole catalogue.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
} satisfies HandlerConfig;

const MAX_COMMAND_SKILLS = 250;

const listSkillCommands = createSafeRootHandler(
  config,
  async function* ({
    getAccessibleWorkspaces,
    memberRole,
    orgAIConfig,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkills.id,
            scope: agentSkills.scope,
            name: agentSkills.name,
            description: agentSkills.description,
            command: agentSkills.command,
            body: agentSkills.body,
            metadata: agentSkills.metadata,
          })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.organizationId, session.activeOrganizationId),
              eq(agentSkills.enabled, true),
              isNotNull(agentSkills.command),
              or(
                eq(agentSkills.scope, AGENT_SKILL_SCOPES[0]), // "team"
                eq(agentSkills.userId, user.id),
              ),
            ),
          )
          .orderBy(
            agentSkills.scope,
            desc(agentSkills.createdAt),
            agentSkills.id,
          )
          .limit(MAX_COMMAND_SKILLS),
      ),
    );

    const availability = yield* Result.await(
      resolveCallerChatSkillAvailability({
        context: {
          getAccessibleWorkspaces,
          memberRole,
          organizationId: session.activeOrganizationId,
          orgAIConfig,
          safeDb,
          scopedDb,
          userId: user.id,
        },
        skills: rows,
      }),
    );

    return Result.ok(
      rows.flatMap(({ metadata: _metadata, ...row }) =>
        availability.get(row.id)?.status ===
        SKILL_TOOL_AVAILABILITY_STATUS.available
          ? [row]
          : [],
      ),
    );
  },
);

export default listSkillCommands;
