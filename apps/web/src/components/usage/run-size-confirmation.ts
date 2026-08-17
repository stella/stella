import { toAPIError } from "@/lib/errors/api";

/**
 * The 428 answer to a queued run whose estimated size needs an explicit
 * go-ahead. The body carries the estimate; the caller re-issues the same
 * request with `confirmedUnits` covering it.
 */
export const RUN_CONFIRMATION_STATUS = 428;

export type RunSizeConfirmationDetail = {
  estimatedUnits: number;
  availableUnits: number;
};

type ConfirmableRequestError = Parameters<typeof toAPIError>[0];

/** Read the structured 428 detail off a rejected request, or `null` when
 *  the error is anything else (including a 428 without the detail). */
export const runSizeConfirmationDetail = (
  error: ConfirmableRequestError,
): RunSizeConfirmationDetail | null => {
  const apiError = toAPIError(error);
  if (apiError.status !== RUN_CONFIRMATION_STATUS) {
    return null;
  }
  const confirmation = apiError.details?.["confirmation"];
  if (typeof confirmation !== "object" || confirmation === null) {
    return null;
  }
  if (
    !("estimatedUnits" in confirmation) ||
    !("availableUnits" in confirmation)
  ) {
    return null;
  }
  const { estimatedUnits, availableUnits } = confirmation;
  if (
    typeof estimatedUnits !== "number" ||
    typeof availableUnits !== "number"
  ) {
    return null;
  }
  return { estimatedUnits, availableUnits };
};
