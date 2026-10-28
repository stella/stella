import { isAIFailureCode } from "@stll/api-contract";
import { isActionAdmissionCode } from "@stll/api-contract/action-admission";

import {
  APIError,
  isDisplayableAPIError,
  toAPIError,
  type ToAPIErrorProps,
} from "@/lib/errors/api";
import { AuthClientError } from "@/lib/errors/auth";
import { ClientOperationError } from "@/lib/errors/client";
import { EmptyUploadFileError } from "@/lib/files/upload-file-validation";

const SERVER_ERROR_THRESHOLD = 500;

/**
 * Which text the user sees for an API error. A server error keeps the
 * caller's own fallback: its message describes the server, not the action.
 * The one exception is a typed AI failure, whose message says what to do
 * (retry, fix the provider key), and which is often answered with a 5xx.
 */
const displayedMessage = (error: APIError, fallback: string): string => {
  if (isActionAdmissionCode(error.code)) {
    return error.message;
  }
  if (!isDisplayableAPIError(error)) {
    return fallback;
  }
  return error.status < SERVER_ERROR_THRESHOLD || isAIFailureCode(error.code)
    ? error.message
    : fallback;
};

export const userErrorMessage = (
  error: ToAPIErrorProps,
  fallback: string,
): string => displayedMessage(toAPIError(error), fallback);

export const userErrorFromThrown = (
  error: unknown,
  fallback: string,
): string => {
  if (
    AuthClientError.is(error) ||
    ClientOperationError.is(error) ||
    EmptyUploadFileError.is(error)
  ) {
    return error.message;
  }
  if (APIError.is(error)) {
    if (error.transportKind !== undefined) {
      return error.message;
    }
    return displayedMessage(error, fallback);
  }
  return fallback;
};
