import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import { legalReaderAnnotations } from "@/api/db/schema";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { wholeAnnotationSql } from "@/api/lib/legal-search/reader-annotations/group";
import {
  ANNOTATION_TARGET_RETURNING,
  returnedAnnotationAuditSubject,
} from "@/api/lib/legal-search/reader-annotations/target";
import type {
  AnnotationAuthorScope,
  AnnotationReach,
} from "@/api/lib/legal-search/reader-annotations/target";

type DeleteReaderAnnotationProps = AnnotationAuthorScope & {
  annotationId: SafeId<"legalReaderAnnotation">;
  /** The marks the calling route may delete. */
  reach: AnnotationReach;
};

type DeleteReaderAnnotationRowsOptions = Omit<
  DeleteReaderAnnotationProps,
  "safeDb"
> & {
  tx: Transaction;
};

/**
 * The locked change inside the caller's transaction, so a route that
 * declares the annotation aggregate takes its lock where the rows change.
 * No rows means the mark is not the caller's or not within reach.
 */
export const deleteReaderAnnotationRows = async ({
  tx,
  annotationId,
  organizationId,
  reach,
  recordAuditEvent,
  userId,
}: DeleteReaderAnnotationRowsOptions) => {
  await withAggregateLock({
    aggregate: "readerAnnotation",
    id: { id: annotationId, organizationId, userId },
    tx,
  });
  const mutatedRows = await tx
    .delete(legalReaderAnnotations)
    .where(
      wholeAnnotationSql({
        annotationId,
        organizationId,
        reach,
        userId,
      }),
    )
    .returning(ANNOTATION_TARGET_RETURNING);
  const first = mutatedRows.at(0);
  if (first !== undefined) {
    const subject = returnedAnnotationAuditSubject(annotationId, first);
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.DELETE,
      resourceType: subject.resourceType,
      resourceId: subject.resourceId,
      ...(subject.workspaceId === undefined
        ? {}
        : { workspaceId: subject.workspaceId, metadata: subject.metadata }),
    });
  }
  return mutatedRows;
};

export const deleteReaderAnnotationHandler = async function* ({
  safeDb,
  ...props
}: DeleteReaderAnnotationProps) {
  const rows = yield* Result.await(
    safeDb(async (tx) => await deleteReaderAnnotationRows({ ...props, tx })),
  );

  if (rows.length === 0) {
    return Result.err(
      new HandlerError({ status: 404, message: "Annotation not found" }),
    );
  }

  return Result.ok({ ok: true as const });
};
