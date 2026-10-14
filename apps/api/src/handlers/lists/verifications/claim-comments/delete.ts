/**
 * Permanently delete one of the caller's comments on a verification claim.
 * Reaches only claim comments of this matter; anyone else's is not found.
 */

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { deleteReaderAnnotationHandler } from "@/api/lib/legal-search/reader-annotations/delete";

const config = {
  contract: "patch",
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

export default deleteClaimComment;
