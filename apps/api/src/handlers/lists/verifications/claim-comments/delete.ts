/**
 * Permanently delete one of the caller's comments on a verification claim.
 * Reaches only claim comments of this matter; anyone else's is not found.
 */

import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { deleteReaderAnnotationRows } from "@/api/lib/legal-search/reader-annotations/delete";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  realtime: noResourceSetUpdates(
    "Claim comments refresh through the claim's own comment query; no listed resource set changes",
  ),
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Permanently delete one of the user's comments on a list verification claim.",
  permissions: { legalReaderAnnotation: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: false,
  },
  params: workspaceParams({ annotationId: tSafeId("legalReaderAnnotation") }),
} satisfies WorkspaceHandlerConfig;

const deleteClaimComment = createSafeHandler(
  config,
  async function* ({
    params,
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
            annotationId: params.annotationId,
            organizationId: session.activeOrganizationId,
            reach: { type: "verification-claim", workspaceId },
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

declareAggregateMutation(deleteClaimComment.handler, {
  type: "aggregate",
  aggregates: ["readerAnnotation"],
});

export default deleteClaimComment;
