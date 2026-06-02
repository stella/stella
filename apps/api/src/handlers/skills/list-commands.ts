import { Result } from "better-result";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";

import { AGENT_SKILL_SCOPES, agentSkills } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

// Returns the subset of skills that carry a slash-command handle,
// shaped for the chat composer's slash menu. Distinct from the
// general `/skills` listing because:
//   1. it always includes `body` (the slash menu inserts it into
//      the composer on pick), which the regular listing intentionally
//      omits to keep the catalogue payload lean
//   2. the result is small (one row per command, capped at 250) so
//      the menu doesn't need pagination
//   3. its cache key is independent so editor mutations don't blow
//      away unrelated catalogue/inspector reads
const config = {
  permissions: { chat: ["create"] },
} satisfies HandlerConfig;

const MAX_COMMAND_SKILLS = 250;

const listSkillCommands = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
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

    return Result.ok(rows);
  },
);

export default listSkillCommands;
