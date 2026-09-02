import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import { abortableTx } from "@/api/db/safe-db";
import { agentSkillComments } from "@/api/db/schema";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type AgentSkillCommentRow = typeof agentSkillComments.$inferSelect;

// Columns intentionally not sent to the client.
const UNPROJECTED_SKILL_COMMENT_COLUMNS = [
  // The route is already scoped to one skill via params.skillId; restating
  // it per-comment would be redundant.
  "skillId",
  // Tenant scope, implied by the caller's active organization.
  "organizationId",
] as const satisfies readonly (keyof AgentSkillCommentRow)[];

// The exact `.select({...})` passed to the query below. Hoisted so the
// selection and the derived `SkillCommentListItem` type can never drift
// apart.
const SKILL_COMMENT_LIST_SELECTION = {
  id: agentSkillComments.id,
  revisionId: agentSkillComments.revisionId,
  proposalId: agentSkillComments.proposalId,
  rangeStart: agentSkillComments.rangeStart,
  rangeEnd: agentSkillComments.rangeEnd,
  anchorText: agentSkillComments.anchorText,
  body: agentSkillComments.body,
  authorId: agentSkillComments.authorId,
  resolvedAt: agentSkillComments.resolvedAt,
  resolvedBy: agentSkillComments.resolvedBy,
  createdAt: agentSkillComments.createdAt,
} as const;

// Select + from only: the row shape this produces is unaffected by the
// `.where()`/`.orderBy()`/`.limit()` the real query below chains onto it,
// so this alone is enough to derive `SkillCommentListItem` from.
const selectSkillCommentListRows = (tx: Transaction) =>
  tx.select(SKILL_COMMENT_LIST_SELECTION).from(agentSkillComments);

type SkillCommentListItem = Awaited<
  ReturnType<typeof selectSkillCommentListRows>
>[number];

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedSkillCommentColumn = UnprojectedColumns<
  AgentSkillCommentRow,
  SkillCommentListItem,
  (typeof UNPROJECTED_SKILL_COMMENT_COLUMNS)[number]
>;
type UnexpectedProjectedSkillCommentColumn = UnbackedProjectionKeys<
  AgentSkillCommentRow,
  SkillCommentListItem,
  (typeof UNPROJECTED_SKILL_COMMENT_COLUMNS)[number]
>;

true satisfies MissingProjectedSkillCommentColumn extends never ? true : never;
true satisfies UnexpectedProjectedSkillCommentColumn extends never
  ? true
  : never;

const listSkillCommentsParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const config = {
  description:
    "List the comments anchored to an agent skill, oldest first, across its " +
    "revisions and proposals. Each carries the character range and the quoted " +
    "text it was written against, and whether it has been resolved.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: listSkillCommentsParamsSchema,
} satisfies HandlerConfig;

const listSkillComments = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session }) {
    const items = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        return await selectSkillCommentListRows(tx)
          .where(
            and(
              eq(agentSkillComments.skillId, params.skillId),
              eq(
                agentSkillComments.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .orderBy(
            asc(agentSkillComments.createdAt),
            asc(agentSkillComments.id),
          )
          .limit(LIMITS.agentSkillCommentsPageSizeMax);
      }),
    );

    return Result.ok({ items });
  },
);

export default listSkillComments;
