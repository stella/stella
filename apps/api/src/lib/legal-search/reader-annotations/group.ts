import { panic } from "better-result";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { READER_DOCUMENT_TARGET_TYPES } from "@stll/api-contract/legal-reader-annotations";

import { legalReaderAnnotations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { AnnotationReach } from "@/api/lib/legal-search/reader-annotations/target";

/**
 * The marks one route may reach by id: public-law documents, one matter's
 * claims, or one matter document's marks.
 */
const reachSql = (reach: AnnotationReach): SQL | undefined => {
  switch (reach.type) {
    case "document": {
      return inArray(legalReaderAnnotations.targetType, [
        ...READER_DOCUMENT_TARGET_TYPES,
      ]);
    }
    case "verification-claim": {
      return and(
        eq(legalReaderAnnotations.targetType, "verification-claim"),
        eq(legalReaderAnnotations.workspaceId, reach.workspaceId),
      );
    }
    case "matter-document": {
      return and(
        eq(legalReaderAnnotations.targetType, "matter-document"),
        eq(legalReaderAnnotations.workspaceId, reach.workspaceId),
        eq(legalReaderAnnotations.entityId, reach.entityId),
      );
    }
    default: {
      reach satisfies never;
      return panic(`Unhandled annotation reach: ${String(reach)}`);
    }
  }
};

/**
 * The rows one mark consists of: the row itself, and every row sharing its
 * group when the passage spans paragraphs. Scoped to the author in the
 * caller's organization, so the predicate alone never reaches a colleague's
 * mark, and to the marks the calling route may reach.
 */
export const wholeAnnotationSql = ({
  annotationId,
  organizationId,
  reach,
  userId,
}: {
  annotationId: SafeId<"legalReaderAnnotation">;
  organizationId: SafeId<"organization">;
  reach: AnnotationReach;
  userId: SafeId<"user">;
}): SQL | undefined =>
  and(
    eq(legalReaderAnnotations.organizationId, organizationId),
    eq(legalReaderAnnotations.userId, userId),
    reachSql(reach),
    // sql-perf-allow: bounded by READER_ANNOTATION_MAX_SPANS rows per group after one primary-key lookup
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
