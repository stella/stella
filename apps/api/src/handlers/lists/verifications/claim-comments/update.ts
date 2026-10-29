/**
 * Change one of the caller's comments on a verification claim: its words or
 * who sees it. Reaches only claim comments of this matter, and only the
 * caller's own.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  annotationCommentTextSchema,
  annotationVisibilitySchema,
} from "@/api/lib/legal-search/reader-annotations/schema";
import { updateReaderAnnotationRows } from "@/api/lib/legal-search/reader-annotations/update";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

/** One named change per request, so an update cannot be empty or ambiguous. */
const bodySchema = v.union([
  v.strictObject({
    change: v.literal("body"),
    body: annotationCommentTextSchema,
  }),
  v.strictObject({
    change: v.literal("visibility"),
    visibility: annotationVisibilitySchema,
  }),
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
  params: workspaceParams({
    annotationId: resourceIdSchema("legalReaderAnnotation"),
  }),
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
    // The lock and the change share this transaction.
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await updateReaderAnnotationRows({
            annotationId: params.annotationId,
            change: body,
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

declareAggregateMutation(updateClaimComment, {
  type: "aggregate",
  aggregates: ["readerAnnotation"],
});

export default updateClaimComment;
