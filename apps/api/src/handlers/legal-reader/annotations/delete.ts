import { Result } from "better-result";

import { legalReaderAnnotations } from "@/api/db/schema";
import { wholeAnnotationSql } from "@/api/handlers/legal-reader/annotations/group";
import {
  annotationParamsSchema,
  requireAnnotationTargetType,
} from "@/api/handlers/legal-reader/annotations/schema";
import {
  annotationAuditSubject,
  DOCUMENT_ANNOTATION_REACH,
} from "@/api/handlers/legal-reader/annotations/target";
import type {
  AnnotationAuthorScope,
  AnnotationReach,
} from "@/api/handlers/legal-reader/annotations/target";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  permissions: { legalReaderAnnotation: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description: "Permanently delete one of the caller's highlights or comments.",
  mcp: { type: "tool", name: "delete_reader_annotation" },
  params: annotationParamsSchema,
} satisfies HandlerConfig;

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

/** Removes the author's own annotation; anyone else's is not found. */
const deleteReaderAnnotation = createSafeRootHandler(
  config,
  async function* ({
    params: { annotationId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    return yield* deleteReaderAnnotationHandler({
      annotationId,
      organizationId: session.activeOrganizationId,
      reach: DOCUMENT_ANNOTATION_REACH,
      recordAuditEvent,
      safeDb,
      userId: user.id,
    });
  },
);

export default deleteReaderAnnotation;
