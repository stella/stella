import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { caseLawDecisionAnnotations } from "@/api/db/schema";
import { decisionParamsSchema } from "@/api/handlers/case-law/annotations/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

/**
 * A reader marks a handful of passages, not hundreds; the bound keeps a
 * runaway client from turning one decision into an unbounded read.
 */
const ANNOTATIONS_LIMIT = 500;

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "reader_annotations" },
  params: decisionParamsSchema,
} satisfies HandlerConfig;

/**
 * Every annotation on one decision the caller may see: their own, and what
 * colleagues shared. Row-level security draws that line; the query only
 * names the decision. The author is read through the organization's
 * membership, so a name is only ever shown for a colleague. Oldest first,
 * so the margin reads in the order the notes were made.
 */
const listDecisionAnnotations = createSafeRootHandler(
  config,
  async function* ({ params: { decisionId }, safeDb, session, user: me }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: caseLawDecisionAnnotations.id,
            groupId: caseLawDecisionAnnotations.groupId,
            kind: caseLawDecisionAnnotations.kind,
            visibility: caseLawDecisionAnnotations.visibility,
            color: caseLawDecisionAnnotations.color,
            style: caseLawDecisionAnnotations.style,
            blockAnchorId: caseLawDecisionAnnotations.blockAnchorId,
            startOffset: caseLawDecisionAnnotations.startOffset,
            endOffset: caseLawDecisionAnnotations.endOffset,
            quote: caseLawDecisionAnnotations.quote,
            body: caseLawDecisionAnnotations.body,
            createdAt: caseLawDecisionAnnotations.createdAt,
            updatedAt: caseLawDecisionAnnotations.updatedAt,
            authorId: caseLawDecisionAnnotations.userId,
            authorName: user.name,
            authorImage: user.image,
            mine: sql<boolean>`${caseLawDecisionAnnotations.userId} = ${me.id}`,
          })
          .from(caseLawDecisionAnnotations)
          .innerJoin(
            member,
            and(
              eq(member.userId, caseLawDecisionAnnotations.userId),
              eq(member.organizationId, session.activeOrganizationId),
            ),
          )
          .innerJoin(user, eq(user.id, member.userId))
          .where(
            and(
              eq(
                caseLawDecisionAnnotations.organizationId,
                session.activeOrganizationId,
              ),
              eq(caseLawDecisionAnnotations.decisionId, decisionId),
            ),
          )
          .orderBy(
            asc(caseLawDecisionAnnotations.createdAt),
            asc(caseLawDecisionAnnotations.id),
          )
          .limit(ANNOTATIONS_LIMIT),
      ),
    );

    return Result.ok({ items: rows });
  },
);

export default listDecisionAnnotations;
