/**
 * Check one claim of a list verification again, against the list's facts as
 * they stand now and the facts a reviewer pointed it at. The grade is
 * recorded as a reviewer event beside the run's own grade, which stays as
 * it was written; the claim is read with the newer grade from then on.
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  orgAIConfigStatusError,
  storedAIConfigUnreadableError,
} from "@/api/lib/ai-config-response";
import { aiHandlerError } from "@/api/lib/ai-error";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import { VERIFICATION_MODEL_TASK } from "@/api/lib/lists/verification/model-call";
import { readVerifiedClaim } from "@/api/lib/lists/verification/read-run";
import { recheckClaim } from "@/api/lib/lists/verification/recheck";
import type { RecheckRefusal } from "@/api/lib/lists/verification/recheck";

const bodySchema = v.object({
  runId: resourceIdSchema("legalListVerificationRun"),
  claimId: resourceIdSchema("legalListClaim"),
  requestKey: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(VERIFICATION_LIMITS.REQUEST_KEY_MAX),
    v.description(
      "A key you choose for this re-check. Sending the same key again " +
        "returns the claim as the first request left it, without grading " +
        "it twice.",
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
    "`recheck` naming the grade it replaced. Repeat a request with the same " +
    "`requestKey` to read its outcome again. A claim set aside as not " +
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

const refusalError = (refusal: RecheckRefusal): HandlerError => {
  switch (refusal.type) {
    case "not-found": {
      return new HandlerError({
        status: 404,
        code: "claim_not_found",
        message: "Claim not found",
      });
    }
    case "too-many-actions": {
      return new HandlerError({
        status: 409,
        code: "claim_review_actions_exhausted",
        message: `A claim holds at most ${String(VERIFICATION_LIMITS.REVIEW_EVENTS_PER_CLAIM_MAX)} review actions.`,
      });
    }
    case "recheck-set-aside-claim": {
      return new HandlerError({
        status: 409,
        code: "claim_set_aside",
        message:
          "This claim is set aside as not verifiable; reopen it with lists.verifications.claim-reviews.create before re-checking it.",
      });
    }
    case "too-many-facts": {
      return new HandlerError({
        status: 422,
        code: "list_too_many_facts",
        message:
          "This list has more facts than one check can read; split it or hold facts that do not bear on the document.",
      });
    }
    case "access-revoked": {
      return new HandlerError({
        status: 403,
        message: "List verification is not available for this matter.",
      });
    }
    case "run-limit": {
      return new HandlerError({
        status: 429,
        code: refusal.error.code,
        message: refusal.error.message,
        hint: refusal.error.hint,
        retryable: true,
      });
    }
    case "grading-failed": {
      return aiHandlerError(refusal.cause, {
        status: 502,
        message: "The claim could not be checked again. Try again.",
      });
    }
    default: {
      refusal satisfies never;
      return panic(`Unhandled re-check refusal: ${String(refusal)}`);
    }
  }
};

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
      return Result.err(refusalError(outcome));
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

export default createClaimRecheck;
