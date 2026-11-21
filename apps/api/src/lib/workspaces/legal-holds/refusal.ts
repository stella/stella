import {
  LEGAL_HOLD_ACTIVE,
  LEGAL_HOLD_ACTIVE_HINT,
  LEGAL_HOLD_REASON_ISSUE_CODE,
} from "@stll/api-contract/legal-holds";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { HandlerErrorValidationIssue } from "@/api/lib/errors/tagged-errors";

import { LegalHoldActiveError, UNIDENTIFIED_LEGAL_HOLD_VIEWER } from "./errors";
import type { LegalHoldViewer } from "./errors";

/**
 * One issue per hold names it (path), its scope (code) and when it was placed
 * (message). A viewer who may read a hold's reason also gets a
 * `<holdId>.reason` issue; nobody else does.
 */
const holdIssues = (
  error: LegalHoldActiveError,
  viewer: LegalHoldViewer,
): HandlerErrorValidationIssue[] =>
  error.holds.flatMap((hold) => {
    const view = hold.view(viewer);
    const placed = { path: view.id, code: view.scope, message: view.placedAt };
    return view.reasonAccess === "granted"
      ? [
          placed,
          {
            path: `${view.id}.reason`,
            code: LEGAL_HOLD_REASON_ISSUE_CODE,
            message: view.reason,
          },
        ]
      : [placed];
  });

/**
 * Preserve the actionable legal-hold refusal across every transport envelope.
 * Without a viewer the refusal names each hold without its reason; the HTTP
 * answer projects it again for the requesting member
 * (`legalHoldRefusalForViewer`).
 */
export const legalHoldRefusal = (
  error: LegalHoldActiveError,
  viewer: LegalHoldViewer = UNIDENTIFIED_LEGAL_HOLD_VIEWER,
): HandlerError<409> =>
  new HandlerError({
    status: 409,
    code: error.code,
    message: error.message,
    hint: LEGAL_HOLD_ACTIVE_HINT,
    issues: holdIssues(error, viewer),
    cause: error,
  });

/** A legal-hold refusal as the given viewer may see it; any other error as is. */
export const legalHoldRefusalForViewer = (
  error: HandlerError,
  viewer: LegalHoldViewer,
): HandlerError =>
  error.code === LEGAL_HOLD_ACTIVE && LegalHoldActiveError.is(error.cause)
    ? legalHoldRefusal(error.cause, viewer)
    : error;
