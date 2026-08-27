import { panic, Result } from "better-result";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillProposals } from "@/api/db/schema";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { requireEditableSkillOrigin } from "@/api/lib/agent-skills/origin";
import { loadLatestSkillRevision } from "@/api/lib/agent-skills/revisions";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const createSkillProposalParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const createSkillProposalBodySchema = t.Object({
  body: t.Optional(
    t.String({ minLength: 1, maxLength: LIMITS.agentSkillBodyMaxChars }),
  ),
  summary: t.Optional(
    t.String({ maxLength: LIMITS.agentSkillProposalSummaryMaxChars }),
  ),
});

const config = {
  description:
    "Open a draft change proposal against an agent skill, branched from its " +
    "newest revision. Omit body to start from that revision's text. The " +
    "skill itself is untouched until someone with edit rights accepts the " +
    "proposal; bundled skills are refused.",
  permissions: { agentSkill: ["propose"] },
  access: "write",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: createSkillProposalParamsSchema,
  body: createSkillProposalBodySchema,
} satisfies HandlerConfig;

const createSkillProposal = createSafeRootHandler(
  config,
  async function* ({ body, params, recordAuditEvent, safeDb, session, user }) {
    const created = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const skill = await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        const editableOrigin = requireEditableSkillOrigin(skill.origin);
        if (Result.isError(editableOrigin)) {
          throw editableOrigin.error;
        }

        const baseRevision = await loadLatestSkillRevision(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });
        if (!baseRevision) {
          panic("agent skill has no revision");
        }

        const rows = await tx
          .insert(agentSkillProposals)
          .values({
            organizationId: session.activeOrganizationId,
            skillId: params.skillId,
            baseRevisionId: baseRevision.id,
            body: body.body ?? baseRevision.body,
            summary: body.summary ?? "",
            status: "draft",
            authorId: user.id,
          })
          .returning({ id: agentSkillProposals.id });

        const row = rows.at(0);
        if (!row) {
          throw new HandlerError({
            status: 500,
            message: "Could not create proposal",
          });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL,
          resourceId: row.id,
          changes: {
            status: { old: null, new: "draft" },
          },
          metadata: {
            skillId: params.skillId,
            baseRevisionId: baseRevision.id,
          },
        });

        return row;
      }),
    );

    return Result.ok({ id: created.id });
  },
);

export default createSkillProposal;
