/**
 * How a refused re-check is answered: the one mapping the single and the
 * bulk re-check routes share, so a claim refused in a bulk request carries
 * the same status, code and message it would get on its own.
 */

import { panic } from "better-result";

import { aiHandlerError } from "@/api/lib/ai-error";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import type { RecheckRefusal } from "@/api/lib/lists/verification/recheck";

export const recheckRefusalError = (refusal: RecheckRefusal): HandlerError => {
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
    case "superseded": {
      return new HandlerError({
        status: 409,
        code: "claim_changed_during_recheck",
        message:
          "The claim's review changed while it was being checked; this result was not recorded. Check it again.",
        retryable: true,
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
