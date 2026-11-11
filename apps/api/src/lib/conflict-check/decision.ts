import { panic, Result } from "better-result";

import { CONFLICT_CHECK_REFUSAL_CODE } from "@stll/api-contract/conflict-checks";
import type {
  ConflictCheckDecisionInput,
  ConflictCheckOutcome,
} from "@stll/api-contract/conflict-checks";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

/** Outcomes a check may be cleared from only by a reviewer, with a note. */
const REVIEWED_CLEARANCE_OUTCOMES = new Set<ConflictCheckOutcome>([
  "potential_conflict",
  "incomplete",
]);

const invalid = (message: string) =>
  Result.err(
    new HandlerError({ status: 400, code: "validation_error", message }),
  );

const reviewRequired = (message: string) =>
  Result.err(
    new HandlerError({
      status: 403,
      code: CONFLICT_CHECK_REFUSAL_CODE.reviewRequired,
      message,
      hint: "Ask an owner or administrator of the organization to record this decision.",
    }),
  );

/**
 * Who may record which decision, and what it must carry. The runner records
 * a conflict, or clears a check that found no potential conflict and searched
 * everything. Clearing a potential conflict or an incomplete check, and any
 * waiver, take a reviewer (four eyes). A waiver rests on the client's recorded
 * consent; replacing a recorded decision needs a note saying why.
 */
export const decisionRefusal = ({
  input,
  outcome,
  isReviewer,
}: {
  input: ConflictCheckDecisionInput;
  outcome: ConflictCheckOutcome;
  isReviewer: boolean;
}): Result<void, HandlerError> => {
  if (input.decision === input.expectedDecision) {
    return invalid("The check already carries this decision");
  }
  if (input.decision !== "waived" && input.consentReference !== undefined) {
    return invalid("Only a waiver carries a consent reference");
  }
  if (input.expectedDecision !== "pending" && input.note === undefined) {
    return invalid("Replacing a recorded decision needs a note saying why");
  }
  switch (input.decision) {
    case "conflict": {
      return Result.ok(undefined);
    }
    case "cleared": {
      if (!REVIEWED_CLEARANCE_OUTCOMES.has(outcome)) {
        return Result.ok(undefined);
      }
      if (!isReviewer) {
        return reviewRequired(
          "Only a reviewer can clear a check that found a potential conflict or did not search every record",
        );
      }
      return input.note === undefined
        ? invalid("Clearing this check needs a note saying why")
        : Result.ok(undefined);
    }
    case "waived": {
      if (!isReviewer) {
        return reviewRequired("Only a reviewer can waive a conflict");
      }
      if (input.consentReference === undefined || input.note === undefined) {
        return invalid(
          "A waiver needs the client's consent reference and a note",
        );
      }
      return Result.ok(undefined);
    }
    default: {
      input.decision satisfies never;
      return panic("Unhandled conflict check decision");
    }
  }
};
