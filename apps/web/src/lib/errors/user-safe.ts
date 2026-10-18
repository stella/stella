import { isActionAdmissionCode } from "@stll/api-contract/action-admission";

import {
  APIError,
  isDisplayableAPIError,
  toAPIError,
  type ToAPIErrorProps,
} from "@/lib/errors/api";
import { AuthClientError } from "@/lib/errors/auth";

const SERVER_ERROR_THRESHOLD = 500;

export const userErrorMessage = (
  error: ToAPIErrorProps,
  fallback: string,
): string => {
  const apiError = toAPIError(error);
  if (isActionAdmissionCode(apiError.code) || isDisplayableAPIError(apiError)) {
    return apiError.message;
  }
  if (error.status >= SERVER_ERROR_THRESHOLD) {
    return fallback;
  }
  return fallback;
};

export const userErrorFromThrown = (
  error: unknown,
  fallback: string,
): string => {
  if (AuthClientError.is(error)) {
    return error.message;
  }
  if (APIError.is(error)) {
    if (isActionAdmissionCode(error.code) || isDisplayableAPIError(error)) {
      return error.message;
    }
    if (error.status >= SERVER_ERROR_THRESHOLD) {
      return fallback;
    }
    return fallback;
  }
  return fallback;
};
