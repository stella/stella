import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const getSkillParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const config = {
  description:
    "Read one agent skill in full: its instruction body, scope, origin, " +
    "version, license, compatibility, source URL, slash command, and every " +
    "resource file with its content. A team skill is readable by every " +
    "member of the organization; a private one only by its author.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: getSkillParamsSchema,
} satisfies HandlerConfig;

const getSkill = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, user }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkills.id,
            scope: agentSkills.scope,
            origin: agentSkills.origin,
            userId: agentSkills.userId,
            slug: agentSkills.slug,
            name: agentSkills.name,
            description: agentSkills.description,
            version: agentSkills.version,
            license: agentSkills.license,
            compatibility: agentSkills.compatibility,
            sourceUrl: agentSkills.sourceUrl,
            contentHash: agentSkills.contentHash,
            enabled: agentSkills.enabled,
            body: agentSkills.body,
            command: agentSkills.command,
            createdAt: agentSkills.createdAt,
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
    const skill = rows.at(0);
    if (!skill) {
      return Result.err(
        new HandlerError({ status: 404, message: "Skill not found" }),
      );
    }

    // Team skills run on behalf of every member, and members propose and
    // comment on them, so their bodies are readable org-wide (the row policy
    // says the same). Editing stays gated on admin/owner in skills.update.
    if (skill.scope === "private" && skill.userId !== user.id) {
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }

    const resources = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkillResources.id,
            path: agentSkillResources.path,
            kind: agentSkillResources.kind,
            sizeBytes: agentSkillResources.sizeBytes,
            content: agentSkillResources.content,
          })
          .from(agentSkillResources)
          .where(eq(agentSkillResources.skillId, skill.id))
          .orderBy(asc(agentSkillResources.path))
          .limit(LIMITS.agentSkillResourcesPerSkill),
      ),
    );

    return Result.ok({ ...skill, resources });
  },
);

export default getSkill;
