import { panic, Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import { legalReaderAnnotations } from "@/api/db/schema";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { wholeAnnotationSql } from "@/api/lib/legal-search/reader-annotations/group";
import {
  requireAnnotationColor,
  requireAnnotationStyle,
  requireAnnotationVisibility,
} from "@/api/lib/legal-search/reader-annotations/schema";
import type { UpdateAnnotationBody } from "@/api/lib/legal-search/reader-annotations/schema";
import {
  ANNOTATION_TARGET_RETURNING,
  returnedAnnotationAuditSubject,
} from "@/api/lib/legal-search/reader-annotations/target";
import type {
  AnnotationAuthorScope,
  AnnotationReach,
} from "@/api/lib/legal-search/reader-annotations/target";

/**
 * The columns one change touches; the change names itself. The words of a
 * comment live on its first row only, so a body change is applied where a
 * body is; every other change reaches the whole group.
 */
const changesFor = (
  body: UpdateAnnotationBody,
): Partial<typeof legalReaderAnnotations.$inferInsert> => {
  switch (body.change) {
    case "body": {
      return { body: body.body };
    }
    case "color": {
      return { color: requireAnnotationColor(body.color) };
    }
    case "style": {
      return { style: requireAnnotationStyle(body.style) };
    }
    case "visibility": {
      return { visibility: requireAnnotationVisibility(body.visibility) };
    }
    default: {
      body satisfies never;
      return panic(`Unhandled body: ${String(body)}`);
    }
  }
};

/**
 * Changes what the author may change: the words of a comment, the colour
 * or style of a highlight, and who sees either. The author predicate is in
 * the query as well as in the row policy, so a colleague's shared note is
 * never touched even if a policy were to loosen.
 */
type UpdateReaderAnnotationProps = AnnotationAuthorScope & {
  annotationId: SafeId<"legalReaderAnnotation">;
  change: UpdateAnnotationBody;
  /** The marks the calling route may change. */
  reach: AnnotationReach;
};

type UpdateReaderAnnotationRowsOptions = Omit<
  UpdateReaderAnnotationProps,
  "safeDb"
> & {
  tx: Transaction;
};

/**
 * The locked change inside the caller's transaction, so a route that
 * declares the annotation aggregate takes its lock where the rows change.
 * No rows means the mark is not the caller's or not within reach.
 */
export const updateReaderAnnotationRows = async ({
  tx,
  annotationId,
  change: body,
  organizationId,
  reach,
  recordAuditEvent,
  userId,
}: UpdateReaderAnnotationRowsOptions) => {
  await withAggregateLock({
    aggregate: "readerAnnotation",
    id: { id: annotationId, organizationId, userId },
    tx,
  });
  const mutatedRows = await tx
    .update(legalReaderAnnotations)
    .set({ ...changesFor(body), updatedAt: new Date() })
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
      action: AUDIT_ACTION.UPDATE,
      resourceType: subject.resourceType,
      resourceId: subject.resourceId,
      ...(subject.workspaceId === undefined
        ? {}
        : { workspaceId: subject.workspaceId }),
      metadata: { ...subject.metadata, change: body.change },
    });
  }
  return mutatedRows;
};

export const updateReaderAnnotationHandler = async function* ({
  safeDb,
  ...props
}: UpdateReaderAnnotationProps) {
  const rows = yield* Result.await(
    safeDb(async (tx) => await updateReaderAnnotationRows({ ...props, tx })),
  );

  if (rows.length === 0) {
    return Result.err(
      new HandlerError({ status: 404, message: "Annotation not found" }),
    );
  }

  return Result.ok({ ok: true as const });
};
