import { panic, Result } from "better-result";

import { legalReaderAnnotations } from "@/api/db/schema";
import { wholeAnnotationSql } from "@/api/handlers/legal-reader/annotations/group";
import {
  annotationParamsSchema,
  requireAnnotationColor,
  requireAnnotationStyle,
  requireAnnotationTargetType,
  requireAnnotationVisibility,
  updateAnnotationBodySchema,
} from "@/api/handlers/legal-reader/annotations/schema";
import type { UpdateAnnotationBody } from "@/api/handlers/legal-reader/annotations/schema";
import { annotationAuditResourceType } from "@/api/handlers/legal-reader/annotations/target";
import type { AnnotationAuthorScope } from "@/api/handlers/legal-reader/annotations/target";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { legalReaderAnnotation: ["update"] },
  mcp: { type: "tool", name: "update_reader_annotation" },
  params: annotationParamsSchema,
  body: updateAnnotationBodySchema,
} satisfies HandlerConfig;

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
};

export const updateReaderAnnotationHandler = async function* ({
  annotationId,
  change: body,
  organizationId,
  recordAuditEvent,
  safeDb,
  userId,
}: UpdateReaderAnnotationProps) {
  const rows = yield* Result.await(
    safeDb(async (tx) => {
      const mutatedRows = await tx
        .update(legalReaderAnnotations)
        .set({ ...changesFor(body), updatedAt: new Date() })
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
          action: AUDIT_ACTION.UPDATE,
          resourceType: annotationAuditResourceType(
            requireAnnotationTargetType(first.targetType),
          ),
          resourceId: annotationId,
          metadata: { change: body.change },
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

const updateReaderAnnotation = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: { annotationId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    return yield* updateReaderAnnotationHandler({
      annotationId,
      change: body,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      safeDb,
      userId: user.id,
    });
  },
);

export default updateReaderAnnotation;
