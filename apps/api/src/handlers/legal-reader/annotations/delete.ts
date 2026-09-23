import { Result } from "better-result";

import { legalReaderAnnotations } from "@/api/db/schema";
import { wholeAnnotationSql } from "@/api/handlers/legal-reader/annotations/group";
import {
  annotationParamsSchema,
  requireAnnotationTargetType,
} from "@/api/handlers/legal-reader/annotations/schema";
import { annotationAuditResourceType } from "@/api/handlers/legal-reader/annotations/target";
import type { AnnotationAuthorScope } from "@/api/handlers/legal-reader/annotations/target";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { legalReaderAnnotation: ["delete"] },
  mcp: { type: "tool", name: "delete_reader_annotation" },
  params: annotationParamsSchema,
} satisfies HandlerConfig;

type DeleteReaderAnnotationProps = AnnotationAuthorScope & {
  annotationId: SafeId<"legalReaderAnnotation">;
};

export const deleteReaderAnnotationHandler = async function* ({
  annotationId,
  organizationId,
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
            userId,
          }),
        )
        .returning({
          id: legalReaderAnnotations.id,
          targetType: legalReaderAnnotations.targetType,
        });
      const first = mutatedRows.at(0);
      if (first !== undefined) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: annotationAuditResourceType(
            requireAnnotationTargetType(first.targetType),
          ),
          resourceId: annotationId,
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
      recordAuditEvent,
      safeDb,
      userId: user.id,
    });
  },
);

export default deleteReaderAnnotation;
