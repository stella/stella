/**
 * The review history of a list verification: every reviewer action on its
 * claims, newest first, with who took it, when, the reason given, and where
 * the claim stood just before and just after (folded from the append-only
 * events, never stored twice).
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  CLAIM_REVIEW_EVENT_KINDS,
  VERIFICATION_LIMITS,
} from "@/api/lib/lists/verification/contract";
import {
  readReviewHistory,
  reviewHistoryCursor,
} from "@/api/lib/lists/verification/review-history";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "List the review history of a list verification, newest first with " +
    "cursor pagination: every reviewer action on its claims, or on one " +
    "claim with `claimId`, optionally only one `kind` of action or one " +
    "reviewer's (`actorId`). Each entry names the reviewer (or `former` " +
    "when their account or membership is gone), the time, the action, the " +
    "reason (`given`, `none`, or `unrecorded` for an action that requires " +
    "one but was recorded before reasons were required), and the claim's " +
    "disposition just before and just after (verdict as reviewers see it, " +
    "override, status). `reviewers` lists everyone who acted on the run " +
    "(`complete`), or says there are more than it names (`overflow`).",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "document_processing",
    consumesServices: false,
  },
  params: workspaceParams({}),
  query: v.object({
    runId: resourceIdSchema("legalListVerificationRun"),
    claimId: v.optional(resourceIdSchema("legalListClaim")),
    kind: v.optional(v.picklist(CLAIM_REVIEW_EVENT_KINDS)),
    actorId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        paginationLimitSchema(VERIFICATION_LIMITS.HISTORY_PAGE_MAX),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const listClaimReviews = createSafeHandler(
  config,
  async function* ({
    query: { runId, claimId, kind, actorId, cursor, limit },
    safeDb,
    session,
    workspaceId,
  }) {
    // An empty cursor is a first page, as a client that forwards an unset
    // cursor sends it; any other value must be one this route issued.
    const decodedCursor =
      cursor === undefined || cursor === ""
        ? null
        : reviewHistoryCursor.decode(cursor);
    if (decodedCursor === null && cursor !== undefined && cursor !== "") {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_cursor",
          message: "Invalid cursor",
        }),
      );
    }
    const pageLimit = normalizeTenantPageLimit(
      limit ?? VERIFICATION_LIMITS.HISTORY_PAGE_MAX,
    );

    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await readReviewHistory({
            tx,
            workspaceId,
            organizationId: session.activeOrganizationId,
            runId,
            ...(claimId === undefined ? {} : { claimId }),
            ...(kind === undefined ? {} : { kind }),
            ...(actorId === undefined ? {} : { actorId }),
            cursor: decodedCursor,
            limit: pageLimit,
          }),
      ),
    );

    switch (result.type) {
      case "run-not-found": {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "verification_not_found",
            message: "Verification not found",
          }),
        );
      }
      case "claim-not-found": {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "claim_not_found",
            message: "Claim not found",
          }),
        );
      }
      case "read": {
        return Result.ok(result.history);
      }
      default: {
        result satisfies never;
        return panic(`Unhandled outcome: ${String(result)}`);
      }
    }
  },
);

export default listClaimReviews;
