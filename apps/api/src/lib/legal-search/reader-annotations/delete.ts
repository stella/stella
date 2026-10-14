import { Result } from "better-result";

import { legalReaderAnnotations } from "@/api/db/schema";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { wholeAnnotationSql } from "@/api/lib/legal-search/reader-annotations/group";
import { requireAnnotationTargetType } from "@/api/lib/legal-search/reader-annotations/schema";
import { annotationAuditSubject } from "@/api/lib/legal-search/reader-annotations/target";
import type {
  AnnotationAuthorScope,
  AnnotationReach,
} from "@/api/lib/legal-search/reader-annotations/target";

type DeleteReaderAnnotationProps = AnnotationAuthorScope & {
  annotationId: SafeId<"legalReaderAnnotation">;
  /** The marks the calling route may delete. */
  reach: AnnotationReach;
};

export const deleteReaderAnnotationHandler = async function* ({
  annotationId,
  organizationId,
  reach,
  recordAuditEvent,
  safeDb,
  userId,
}: DeleteReaderAnnotationProps) {
  const rows = yield* Result.await(
    safeDb(async (tx) => {
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
        .returning({
          id: legalReaderAnnotations.id,
          targetType: legalReaderAnnotations.targetType,
          verificationClaimId: legalReaderAnnotations.verificationClaimId,
          verificationRunId: legalReaderAnnotations.verificationRunId,
          workspaceId: legalReaderAnnotations.workspaceId,
        });
      const first = mutatedRows.at(0);
      if (first !== undefined) {
        const subject = annotationAuditSubject({
          annotationId,
          targetType: requireAnnotationTargetType(first.targetType),
          verificationClaimId: first.verificationClaimId,
          verificationRunId: first.verificationRunId,
          workspaceId: first.workspaceId,
        });
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
    }),
  );

  if (rows.length === 0) {
    return Result.err(
      new HandlerError({ status: 404, message: "Annotation not found" }),
    );
  }

  return Result.ok({ ok: true as const });
};
