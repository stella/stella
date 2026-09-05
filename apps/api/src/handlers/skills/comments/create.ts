import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import { abortableTx } from "@/api/db/safe-db";
import {
  agentSkillComments,
  agentSkillProposals,
  agentSkillRevisions,
} from "@/api/db/schema";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import { validateCommentRange } from "./range";

const createSkillCommentParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const createSkillCommentBodySchema = t.Object({
  revisionId: t.Optional(tSafeId("agentSkillRevision")),
  proposalId: t.Optional(tSafeId("agentSkillProposal")),
  rangeStart: t.Integer({ minimum: 0 }),
  rangeEnd: t.Integer({ minimum: 0 }),
  body: t.String({
    minLength: 1,
    maxLength: LIMITS.agentSkillCommentBodyMaxChars,
  }),
});

const config = {
  description:
    "Comment on a character range of one revision of an agent skill, or of a " +
    "proposal's body. Pass exactly one of revisionId and proposalId; a " +
    "comment on a proposal is also anchored to the revision that proposal " +
    "branched from. The quoted source text is captured from the range so the " +
    "comment survives the text moving on.",
  permissions: { agentSkill: ["comment"] },
  access: "write",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: createSkillCommentParamsSchema,
  body: createSkillCommentBodySchema,
} satisfies HandlerConfig;

/** What the comment was written against: a stored revision, or a proposal's
 *  working body. */
type CommentAnchor =
  | { type: "revision"; revisionId: SafeId<"agentSkillRevision"> }
  | { type: "proposal"; proposalId: SafeId<"agentSkillProposal"> };

type CommentTarget = {
  revisionId: SafeId<"agentSkillRevision">;
  /** The text the range is measured against. */
  text: string;
};

type LoadCommentTargetOptions = {
  anchor: CommentAnchor;
  skillId: SafeId<"agentSkill">;
  organizationId: SafeId<"organization">;
};

const loadCommentTarget = async (
  tx: Transaction,
  { anchor, skillId, organizationId }: LoadCommentTargetOptions,
): Promise<CommentTarget> => {
  switch (anchor.type) {
    case "proposal": {
      const rows = await tx
        .select({
          baseRevisionId: agentSkillProposals.baseRevisionId,
          body: agentSkillProposals.body,
        })
        .from(agentSkillProposals)
        .where(
          and(
            eq(agentSkillProposals.id, anchor.proposalId),
            eq(agentSkillProposals.skillId, skillId),
            eq(agentSkillProposals.organizationId, organizationId),
          ),
        )
        .limit(1);

      const proposal = rows.at(0);
      if (!proposal) {
        throw new HandlerError({
          status: 404,
          message: "Proposal not found",
        });
      }

      return { revisionId: proposal.baseRevisionId, text: proposal.body };
    }
    case "revision": {
      const rows = await tx
        .select({
          id: agentSkillRevisions.id,
          body: agentSkillRevisions.body,
        })
        .from(agentSkillRevisions)
        .where(
          and(
            eq(agentSkillRevisions.id, anchor.revisionId),
            eq(agentSkillRevisions.skillId, skillId),
            eq(agentSkillRevisions.organizationId, organizationId),
          ),
        )
        .limit(1)
        // Serializes with the revision trigger so a concurrent save cannot
        // coalesce into this revision after the comment read its body.
        .for("share");

      const revision = rows.at(0);
      if (!revision) {
        throw new HandlerError({
          status: 404,
          message: "Revision not found",
        });
      }

      return { revisionId: revision.id, text: revision.body };
    }
    default: {
      anchor satisfies never;
      return panic(`Unhandled anchor: ${String(anchor)}`);
    }
  }
};

const resolveCommentAnchor = ({
  proposalId,
  revisionId,
}: {
  proposalId?: SafeId<"agentSkillProposal"> | undefined;
  revisionId?: SafeId<"agentSkillRevision"> | undefined;
}): CommentAnchor | null => {
  if (proposalId !== undefined && revisionId === undefined) {
    return { type: "proposal", proposalId };
  }
  if (revisionId !== undefined && proposalId === undefined) {
    return { type: "revision", revisionId };
  }

  return null;
};

const createSkillComment = createSafeRootHandler(
  config,
  async function* ({ body, params, recordAuditEvent, safeDb, session, user }) {
    const anchor = resolveCommentAnchor({
      proposalId: body.proposalId,
      revisionId: body.revisionId,
    });
    if (!anchor) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Pass exactly one of revisionId and proposalId",
        }),
      );
    }

    const created = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        const target = await loadCommentTarget(tx, {
          anchor,
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        const range = validateCommentRange({
          rangeStart: body.rangeStart,
          rangeEnd: body.rangeEnd,
          textLength: target.text.length,
        });
        if (Result.isError(range)) {
          throw range.error;
        }

        const proposalId =
          anchor.type === "proposal" ? anchor.proposalId : null;

        const rows = await tx
          .insert(agentSkillComments)
          .values({
            organizationId: session.activeOrganizationId,
            skillId: params.skillId,
            revisionId: target.revisionId,
            proposalId,
            rangeStart: body.rangeStart,
            rangeEnd: body.rangeEnd,
            // Quoted from the validated range, never taken from the caller,
            // so the stored quote always matches what was selected.
            anchorText: target.text
              .slice(body.rangeStart, body.rangeEnd)
              .slice(0, LIMITS.agentSkillCommentAnchorTextMaxChars),
            body: body.body,
            authorId: user.id,
          })
          .returning({ id: agentSkillComments.id });

        const row = rows.at(0);
        if (!row) {
          throw new HandlerError({
            status: 500,
            message: "Could not create comment",
          });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL_COMMENT,
          resourceId: row.id,
          metadata: {
            skillId: params.skillId,
            revisionId: target.revisionId,
            proposalId,
          },
        });

        return row;
      }),
    );

    return Result.ok({ id: created.id });
  },
);

export default createSkillComment;
