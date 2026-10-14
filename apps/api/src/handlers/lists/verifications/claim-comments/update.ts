/**
 * Change one of the caller's comments on a verification claim: its words or
 * who sees it. Reaches only claim comments of this matter, and only the
 * caller's own.
 */

import { t } from "elysia";

import {
  annotationCommentTextSchema,
  annotationVisibilitySchema,
} from "@/api/handlers/legal-reader/annotations/schema";
import { updateReaderAnnotationHandler } from "@/api/handlers/legal-reader/annotations/update";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";

/** One named change per request, so an update cannot be empty or ambiguous. */
const bodySchema = t.Union([
  t.Object(
    { change: t.Literal("body"), body: annotationCommentTextSchema },
    { additionalProperties: false },
  ),
  t.Object(
    { change: t.Literal("visibility"), visibility: annotationVisibilitySchema },
    { additionalProperties: false },
  ),
]);

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Change one of the user's comments on a list verification claim: its " +
    "words (`body`) or who sees it (`visibility`: private, or shared with " +
    "everyone who can open the matter).",
  permissions: { legalReaderAnnotation: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: false,
  },
  params: workspaceParams({ annotationId: tSafeId("legalReaderAnnotation") }),
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const updateClaimComment = createSafeHandler(
  config,
  async function* ({
    body,
    params,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    return yield* updateReaderAnnotationHandler({
      annotationId: params.annotationId,
      change: body,
      organizationId: session.activeOrganizationId,
      reach: { type: "verification-claim", workspaceId },
      recordAuditEvent,
      safeDb,
      userId: user.id,
    });
  },
);

export default updateClaimComment;
