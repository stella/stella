import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { caseLawDecisionAnnotations } from "@/api/db/schema";
import { decisionParamsSchema } from "@/api/handlers/case-law/annotations/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedCaseLawDecisionAnnotationId } from "@/api/lib/safe-id-boundaries";

const querySchema = t.Object({
  cursor: t.Optional(tPaginationCursor()),
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawAnnotationsPageSizeMax)),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "reader_annotations" },
  params: decisionParamsSchema,
  query: querySchema,
} satisfies HandlerConfig;

const annotationCursor = createTimestampIdCursorCodec({
  column: caseLawDecisionAnnotations.createdAt,
  brandId: brandPersistedCaseLawDecisionAnnotationId,
});

/**
 * Every annotation on one decision the caller may see: their own, and what
 * colleagues shared. Row-level security draws that line; the query only
 * names the decision. The author is read through the organization's
 * membership, so a name is only ever shown for a colleague. Oldest first,
 * so the margin reads in the order the notes were made.
 */
const listDecisionAnnotations = createSafeRootHandler(
  config,
  async function* ({
    params: { decisionId },
    query,
    safeDb,
    session,
    user: me,
  }) {
    const limit = query.limit ?? LIMITS.caseLawAnnotationsPageSizeDefault;
    const conditions = [
      eq(
        caseLawDecisionAnnotations.organizationId,
        session.activeOrganizationId,
      ),
      eq(caseLawDecisionAnnotations.decisionId, decisionId),
    ];

    if (query.cursor) {
      const cursor = annotationCursor.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const cursorCondition = annotationCursor.keysetAfter({
        cursor,
        direction: "ascending",
        idColumn: caseLawDecisionAnnotations.id,
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

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
            createdAtCursor:
              annotationCursor.cursorValue.as("created_at_cursor"),
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
          .where(and(...conditions))
          .orderBy(
            asc(caseLawDecisionAnnotations.createdAt),
            asc(caseLawDecisionAnnotations.id),
          )
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        annotationCursor.encode(item.createdAtCursor, item.id),
    });

    return Result.ok({
      ...page,
      items: page.items.map(({ createdAtCursor: _, ...item }) => item),
    });
  },
);

export default listDecisionAnnotations;
