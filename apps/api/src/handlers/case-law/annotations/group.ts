import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { caseLawDecisionAnnotations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * The rows one mark consists of: the row itself, and every row sharing its
 * group when the passage spans paragraphs. Scoped to the author in the
 * caller's organization, so the predicate alone never reaches a colleague's
 * mark.
 */
export const wholeAnnotationSql = ({
  annotationId,
  organizationId,
  userId,
}: {
  annotationId: SafeId<"caseLawDecisionAnnotation">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}): SQL | undefined =>
  and(
    eq(caseLawDecisionAnnotations.organizationId, organizationId),
    eq(caseLawDecisionAnnotations.userId, userId),
    or(
      eq(caseLawDecisionAnnotations.id, annotationId),
      and(
        isNotNull(caseLawDecisionAnnotations.groupId),
        eq(
          caseLawDecisionAnnotations.groupId,
          sql`(SELECT ${caseLawDecisionAnnotations.groupId} FROM ${caseLawDecisionAnnotations} WHERE ${caseLawDecisionAnnotations.id} = ${annotationId})`,
        ),
      ),
    ),
  );
