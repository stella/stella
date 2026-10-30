/**
 * Change one of the caller's marks on a matter document: a comment's words,
 * a highlight's colour or style, or who sees it. Reaches only this
 * document's marks in this matter, and only the caller's own.
 */

import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { updateAnnotationBodySchema } from "@/api/lib/legal-search/reader-annotations/schema";
import { updateReaderAnnotationRows } from "@/api/lib/legal-search/reader-annotations/update";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  realtime: noResourceSetUpdates(
    "Document marks refresh through the document's own mark query; no listed resource set changes",
  ),
  description:
    "Change one of the user's highlights or comments on a matter document: " +
    "its words (`body`), colour, style, or who sees it (`visibility`: " +
    "private, or shared with everyone who can open the matter).",
  permissions: { legalReaderAnnotation: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({
    entityId: resourceIdSchema("entity"),
    annotationId: resourceIdSchema("legalReaderAnnotation"),
  }),
  body: updateAnnotationBodySchema,
} satisfies WorkspaceHandlerConfig;

const updateDocumentAnnotation = createSafeHandler(
  config,
  async function* ({
    body,
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
          await updateReaderAnnotationRows({
            annotationId,
            change: body,
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

declareAggregateMutation(updateDocumentAnnotation, {
  type: "aggregate",
  aggregates: ["readerAnnotation"],
});

export default updateDocumentAnnotation;
