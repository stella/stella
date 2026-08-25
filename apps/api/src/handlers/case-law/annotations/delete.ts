import { Result } from "better-result";

import { caseLawDecisionAnnotations } from "@/api/db/schema";
import { wholeAnnotationSql } from "@/api/handlers/case-law/annotations/group";
import { annotationParamsSchema } from "@/api/handlers/case-law/annotations/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "reader_annotations" },
  params: annotationParamsSchema,
} satisfies HandlerConfig;

/** Removes the author's own annotation; anyone else's is not found. */
const deleteDecisionAnnotation = createSafeRootHandler(
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
          .delete(caseLawDecisionAnnotations)
          .where(
            wholeAnnotationSql({
              annotationId,
              organizationId: session.activeOrganizationId,
              userId: user.id,
            }),
          )
          .returning({ id: caseLawDecisionAnnotations.id });
        if (mutatedRows.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_DECISION_ANNOTATION,
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

export default deleteDecisionAnnotation;
