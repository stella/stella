import { Result } from "better-result";

import { legalReaderAnnotations } from "@/api/db/schema";
import { wholeAnnotationSql } from "@/api/handlers/legal-reader/annotations/group";
import {
  annotationParamsSchema,
  requireAnnotationTargetType,
} from "@/api/handlers/legal-reader/annotations/schema";
import { annotationAuditResourceType } from "@/api/handlers/legal-reader/annotations/target";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { legalReaderAnnotation: ["delete"] },
  mcp: { type: "internal", reason: "reader_annotations" },
  params: annotationParamsSchema,
} satisfies HandlerConfig;

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
    const rows = yield* Result.await(
      safeDb(async (tx) => {
        const mutatedRows = await tx
          .delete(legalReaderAnnotations)
          .where(
            wholeAnnotationSql({
              annotationId,
              organizationId: session.activeOrganizationId,
              userId: user.id,
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
  },
);

export default deleteReaderAnnotation;
