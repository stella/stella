/**
 * Permanently delete one of the caller's comments on a verification claim.
 * Reaches only claim comments of this matter; anyone else's is not found.
 */

import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { deleteReaderAnnotationHandler } from "@/api/lib/legal-search/reader-annotations/delete";
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
    yield* Result.await(
      safeDb(
        async (tx) =>
          await withAggregateLock({
            aggregate: "readerAnnotation",
            id: {
              id: params.annotationId,
              organizationId: session.activeOrganizationId,
              userId: user.id,
            },
            tx,
          }),
      ),
    );
    return yield* deleteReaderAnnotationHandler({
      annotationId: params.annotationId,
      organizationId: session.activeOrganizationId,
      reach: { type: "verification-claim", workspaceId },
      recordAuditEvent,
      safeDb,
      userId: user.id,
    });
  },
);

declareAggregateMutation(deleteClaimComment.handler, {
  type: "aggregate",
  aggregates: ["readerAnnotation"],
});

export default deleteClaimComment;
