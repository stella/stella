/**
 * Check several claims of one list verification again in one request: the
 * same grading, budget and history as checking one claim, with each claim's
 * outcome reported on its own, so one refused claim never hides another's
 * new grade.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  orgAIConfigStatusError,
  storedAIConfigUnreadableError,
} from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, uniqueItems } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import { VERIFICATION_MODEL_TASK } from "@/api/lib/lists/verification/model-call";
import {
  recheckClaims,
  RECHECKS_PER_REQUEST_MAX,
} from "@/api/lib/lists/verification/recheck";
import { recheckRefusalError } from "@/api/lib/lists/verification/recheck-refusal";

const bodySchema = v.object({
  runId: resourceIdSchema("legalListVerificationRun"),
  claims: v.pipe(
    v.array(
      v.object({
        claimId: resourceIdSchema("legalListClaim"),
        requestKey: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(VERIFICATION_LIMITS.REQUEST_KEY_MAX),
          v.description(
            "A key you choose for this claim's re-check. Sending the same " +
              "key for the claim again grades nothing twice: its result " +
              "says replayed true.",
          ),
        ),
      }),
    ),
    v.minLength(1),
    v.maxLength(RECHECKS_PER_REQUEST_MAX),
    uniqueItems((claim) => claim.claimId),
  ),
});

const config = {
  contract: "patch",
  actionAdmission: {
    type: "handler",
    actionKind: "list-verification.recheck",
  },
  description:
    "Grade several claims of one list verification again, each as " +
    "lists.verifications.claim-rechecks.create does: against the verified " +
    "list's facts as they stand now (held facts are left out) and the facts " +
    "linked to it, recording the new grade in the claim's history and " +
    "withdrawing its earlier status, override, reopening and record-conflict " +
    "resolution. Use it for the claims lists.verifications.get reports as " +
    "out of date (`staleness`). Returns one result per claim: `rechecked` " +
    "(with `replayed: true` when its `requestKey` already graded it), or " +
    "`refused` with the error that claim alone would get. When every claim " +
    "is refused for the same reason (an organization at its verification " +
    "limit is refused before any claim is graded), the request fails with " +
    "that error.",
  permissions: { workspace: ["read"], entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: true,
  },
  body: bodySchema,
  requiresUsage: {
    actionType: "doc_review",
    serviceTier: "standard",
    modelTask: VERIFICATION_MODEL_TASK,
  },
} satisfies WorkspaceHandlerConfig;

const createBulkClaimRechecks = createSafeHandler(
  config,
  async function* ({
    actionSignal,
    body,
    managedAIResidency,
    modelAdmission,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    recordAuditEvent,
    request,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    // Checked apart so the settings the grading needs narrow to readable.
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError());
    }
    const configError = orgAIConfigStatusError(orgAIConfigStatus);
    if (configError) {
      return Result.err(configError);
    }
    const { runId, claims } = body;
    const outcomes = yield* Result.await(
      recheckClaims({
        safeDb,
        workspaceId,
        runId,
        requests: claims,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        admission: configuredModelAdmission({ modelAdmission }),
        orgAIConfig,
        managedAIResidency,
        promptCachingEnabled,
        recordAuditEvent,
        signal: actionSignal ?? request.signal,
      }),
    );
    const results = claims.map(({ claimId }) => {
      const outcome = outcomes.get(claimId) ?? {
        type: "not-found" as const,
      };
      if (outcome.type === "rechecked") {
        return {
          claimId,
          status: "rechecked" as const,
          replayed: outcome.replayed,
        };
      }
      const error = recheckRefusalError(outcome);
      return {
        claimId,
        status: "refused" as const,
        error: {
          status: error.status,
          code: error.code ?? null,
          message: error.message,
          retryable: error.retryable === true,
        },
        refusal: outcome,
      };
    });
    // A refusal every claim shares (a budget at its limit, a run that is
    // not there) is the request's own, answered as one claim's would be.
    const first = results.at(0);
    if (
      first?.status === "refused" &&
      results.every(
        (result) =>
          result.status === "refused" &&
          result.refusal.type === first.refusal.type,
      )
    ) {
      return Result.err(recheckRefusalError(first.refusal));
    }
    return Result.ok({
      results: results.map((result) =>
        result.status === "rechecked"
          ? result
          : {
              claimId: result.claimId,
              status: result.status,
              error: result.error,
            },
      ),
    });
  },
);

declareAggregateMutation(createBulkClaimRechecks, {
  type: "independent",
  reason:
    "Appends one review event per graded claim; the claims' row locks, taken in id order, serialize their events, and each claim's request key, action cap and the review its grade answered are re-read under them before the insert. No aggregate state spans claims.",
});

export default createBulkClaimRechecks;
