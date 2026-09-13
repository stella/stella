import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { legalReaderAnnotations } from "@/api/db/schema";
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
  annotationId: SafeId<"legalReaderAnnotation">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}): SQL | undefined =>
  and(
    eq(legalReaderAnnotations.organizationId, organizationId),
    eq(legalReaderAnnotations.userId, userId),
    or(
      eq(legalReaderAnnotations.id, annotationId),
      and(
        isNotNull(legalReaderAnnotations.groupId),
        eq(
          legalReaderAnnotations.groupId,
          sql`(SELECT ${legalReaderAnnotations.groupId} FROM ${legalReaderAnnotations} WHERE ${legalReaderAnnotations.id} = ${annotationId})`,
        ),
      ),
    ),
  );
