import { LEGAL_HOLD_ACTIVE_HINT } from "@stll/api-contract/legal-holds";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

import type { LegalHoldActiveError } from "./errors";

/** Preserve the actionable legal-hold refusal across every transport envelope. */
export const legalHoldRefusal = (
  error: LegalHoldActiveError,
): HandlerError<409> =>
  new HandlerError({
    status: 409,
    code: error.code,
    message: error.message,
    hint: LEGAL_HOLD_ACTIVE_HINT,
    issues: error.holds.map((hold) => ({
      path: hold.id,
      code: hold.scope,
      message: hold.placedAt.toISOString(),
    })),
    cause: error,
  });
