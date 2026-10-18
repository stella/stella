/**
 * Change one of the caller's comments on a verification claim: its words or
 * who sees it. Reaches only claim comments of this matter, and only the
 * caller's own.
 */

import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  annotationCommentTextSchema,
  annotationVisibilitySchema,
} from "@/api/lib/legal-search/reader-annotations/schema";
import { updateReaderAnnotationHandler } from "@/api/lib/legal-search/reader-annotations/update";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

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
  realtime: noResourceSetUpdates(
    "Claim comments refresh through the claim's own comment query; no listed resource set changes",
  ),
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

declareAggregateMutation(updateClaimComment.handler, {
  type: "aggregate",
  aggregates: ["readerAnnotation"],
});

export default updateClaimComment;
