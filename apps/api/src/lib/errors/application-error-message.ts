import { Result } from "better-result";

import { FlowStepError, HandlerError } from "@/api/lib/errors/tagged-errors";

// Only these application classes author messages for stream and persisted failures.
const APPLICATION_MESSAGE_ERRORS = { HandlerError, FlowStepError } as const;
export type ApplicationMessageError = InstanceType<
  (typeof APPLICATION_MESSAGE_ERRORS)[keyof typeof APPLICATION_MESSAGE_ERRORS]
>;

const isApplicationMessageError = (
  error: unknown,
): error is ApplicationMessageError =>
  Object.values(APPLICATION_MESSAGE_ERRORS).some(
    (ErrorClass) => error instanceof ErrorClass,
  );

/** Unapproved errors may carry foreign text; only approved classes expose a message. */
export const applicationErrorMessage = (
  error: unknown,
  fallback: string,
): string =>
  Result.try(() =>
    isApplicationMessageError(error) ? error.message : fallback,
  ).unwrapOr(fallback);
