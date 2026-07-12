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
  if (error.status >= SERVER_ERROR_THRESHOLD) {
    return fallback;
  }
  const apiError = toAPIError(error);
  return isDisplayableAPIError(apiError) ? apiError.message : fallback;
};

export const userErrorFromThrown = (
  error: unknown,
  fallback: string,
): string => {
  if (AuthClientError.is(error)) {
    return error.message;
  }
  if (APIError.is(error)) {
    if (error.status >= SERVER_ERROR_THRESHOLD) {
      return fallback;
    }
    return isDisplayableAPIError(error) ? error.message : fallback;
  }
  return fallback;
};
