/**
 * Comment on one claim of a list verification. The comment is a reader
 * annotation on the claim's own words, stored and audited like a comment in
 * the case-law reader, and scoped to the matter: the claim is read under the
 * caller's matter scope, and the row's own policy re-checks it on insert.
 */

import { Result } from "better-result";
import { t } from "elysia";

import {
  claimCommentSpan,
  readCommentedClaim,
} from "@/api/handlers/lists/verifications/claim-comments/claim";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { createReaderAnnotationHandler } from "@/api/lib/legal-search/reader-annotations/create";
import {
  annotationCommentTextSchema,
  annotationVisibilitySchema,
  requireAnnotationVisibility,
} from "@/api/lib/legal-search/reader-annotations/schema";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const bodySchema = t.Object(
  {
    runId: tSafeId("legalListVerificationRun"),
    claimId: tSafeId("legalListClaim"),
    body: annotationCommentTextSchema,
    visibility: t.Optional(annotationVisibilitySchema),
    requestId: t.Optional(tSafeId("legalReaderAnnotation")),
  },
  { additionalProperties: false },
);

const config = {
  contract: "patch",
  realtime: noResourceSetUpdates(
    "Claim comments refresh through the claim's own comment query; no listed resource set changes",
  ),
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Comment on one claim of a list verification, as the user. The comment " +
    "covers the claim's own words; it is private unless visibility is " +
    "shared, which shows it to everyone who can open the matter. Resending " +
    "the same requestId returns the comment it already made.",
  permissions: { legalReaderAnnotation: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: false,
  },
  params: workspaceParams({}),
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const createClaimComment = createSafeHandler(
  config,
  async function* ({
    body,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const { claimId, runId } = body;
    yield* Result.await(
      safeDb(
        async (tx) =>
          await withAggregateLock({
            aggregate: "workspace",
            id: {
              id: workspaceId,
              organizationId: session.activeOrganizationId,
            },
            mode: "key share",
            tx,
          }),
      ),
    );
    const claim = yield* Result.await(
      safeDb(
        async (tx) =>
          await readCommentedClaim({ claimId, runId, tx, workspaceId }),
      ),
    );
    if (claim === undefined) {
      return Result.err(
        new HandlerError({ status: 404, message: "Claim not found" }),
      );
    }

    return yield* createReaderAnnotationHandler({
      body: {
        body: body.body,
        kind: "comment",
        spans: [claimCommentSpan(claim)],
        targetId: claimId,
        targetType: "verification-claim",
        visibility: requireAnnotationVisibility(body.visibility ?? "private"),
        ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
      },
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      safeDb,
      userId: user.id,
      verificationClaim: { claimId, runId, workspaceId },
    });
  },
);

declareAggregateMutation(createClaimComment.handler, {
  type: "aggregate",
  aggregates: ["workspace"],
});

export default createClaimComment;
