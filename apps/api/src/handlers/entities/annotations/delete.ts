/**
 * Permanently delete one of the caller's marks on a matter document. Reaches
 * only this document's marks in this matter; anyone else's is not found.
 */

import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { deleteReaderAnnotationRows } from "@/api/lib/legal-search/reader-annotations/delete";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  realtime: noResourceSetUpdates(
    "Document marks refresh through the document's own mark query; no listed resource set changes",
  ),
  description:
    "Permanently delete one of the user's highlights or comments on a matter document.",
  permissions: { legalReaderAnnotation: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({
    entityId: resourceIdSchema("entity"),
    annotationId: resourceIdSchema("legalReaderAnnotation"),
  }),
} satisfies WorkspaceHandlerConfig;

const deleteDocumentAnnotation = createSafeHandler(
  config,
  async function* ({
    params: { annotationId, entityId },
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    // The lock and the change share this transaction.
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await deleteReaderAnnotationRows({
            annotationId,
            organizationId: session.activeOrganizationId,
            reach: { type: "matter-document", entityId, workspaceId },
            recordAuditEvent,
            tx,
            userId: user.id,
          }),
      ),
    );
    if (rows.length === 0) {
      return Result.err(
        new HandlerError({ status: 404, message: "Annotation not found" }),
      );
    }
    return Result.ok({ ok: true as const });
  },
);

declareAggregateMutation(deleteDocumentAnnotation, {
  type: "aggregate",
  aggregates: ["readerAnnotation"],
});

export default deleteDocumentAnnotation;
