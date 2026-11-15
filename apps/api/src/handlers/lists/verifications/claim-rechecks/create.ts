/**
 * Check one claim of a list verification again, against the list's facts as
 * they stand now and the facts a reviewer pointed it at. The grade is
 * recorded as a reviewer event beside the run's own grade, which stays as
 * it was written; the claim is read with the newer grade from then on.
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
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import { VERIFICATION_MODEL_TASK } from "@/api/lib/lists/verification/model-call";
import { readVerifiedClaim } from "@/api/lib/lists/verification/read-run";
import { recheckClaim } from "@/api/lib/lists/verification/recheck";
import { recheckRefusalError } from "@/api/lib/lists/verification/recheck-refusal";

const bodySchema = v.object({
  runId: resourceIdSchema("legalListVerificationRun"),
  claimId: resourceIdSchema("legalListClaim"),
  requestKey: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(VERIFICATION_LIMITS.REQUEST_KEY_MAX),
    v.description(
      "A key you choose for this re-check. Sending the same key again " +
        "grades nothing twice: it returns replayed true and the claim as it " +
        "reads now, which later review actions may have changed.",
    ),
  ),
});

const config = {
  contract: "patch",
  actionAdmission: {
    type: "handler",
    actionKind: "list-verification.recheck",
  },
  description:
    "Grade one claim of a list verification again, against the verified " +
    "list's facts as they stand now (held facts are left out) and any facts " +
    "linked to it with lists.verifications.claim-reviews.create " +
    "(`fact-link`). The new grade is recorded in the claim's history with " +
    "who asked and the facts it read; the run's own grade is kept. A new " +
    "grade withdraws the claim's earlier status, override, reopening and " +
    "record-conflict resolution. Returns the claim as it now reads, with " +
    "`recheck` naming the grade it replaced. Repeating a request with the " +
    "same `requestKey` grades nothing again: it returns `replayed: true` and " +
    "the claim as it reads now, which later review actions may have " +
    "changed, not the first response. A claim set aside as not " +
    "verifiable is reopened first.",
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

const createClaimRecheck = createSafeHandler(
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
    const { runId, claimId, requestKey } = body;
    const outcome = yield* Result.await(
      recheckClaim({
        safeDb,
        workspaceId,
        runId,
        claimId,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        requestKey,
        admission: configuredModelAdmission({ modelAdmission }),
        orgAIConfig,
        managedAIResidency,
        promptCachingEnabled,
        recordAuditEvent,
        signal: actionSignal ?? request.signal,
      }),
    );
    if (outcome.type !== "rechecked") {
      return Result.err(recheckRefusalError(outcome));
    }
    const claim = yield* Result.await(
      safeDb(
        async (tx) =>
          await readVerifiedClaim({ tx, workspaceId, runId, claimId }),
      ),
    );
    if (claim === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "claim_not_found",
          message: "Claim not found",
        }),
      );
    }
    return Result.ok({ replayed: outcome.replayed, claim });
  },
);

declareAggregateMutation(createClaimRecheck, {
  type: "independent",
  reason:
    "Appends one review event to one claim; the claim's row lock serializes its events, and the request key, the action cap and the review the grade answered are re-read under it before the insert. No aggregate state spans claims.",
});

export default createClaimRecheck;
