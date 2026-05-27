import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkills } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const getSkillParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const config = {
  permissions: { chat: ["create"] },
  params: getSkillParamsSchema,
} satisfies HandlerConfig;

const getSkill = createSafeRootHandler(
  config,
  async function* ({ memberRole, params, safeDb, session, user }) {
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

    if (
      skill.scope === "team" &&
      !["admin", "owner"].includes(memberRole.role)
    ) {
      // Non-admins can still see team skills in the list, but reading the full
      // body is gated on the same role check as edit/delete to keep the editor
      // and the permission model in sync.
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }
    if (skill.scope === "private" && skill.userId !== user.id) {
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }

    return Result.ok(skill);
  },
);

export default getSkill;
