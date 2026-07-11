import { APIError } from "@/lib/errors/api";
import { CriticalQueryTimeoutError } from "@/lib/react-query";

/** Network errors that indicate a transient connectivity
 *  issue (API down, DNS failure, etc.).
 *  Message varies by browser engine:
 *  - Chromium: "Failed to fetch"
 *  - Firefox:  "NetworkError when attempting to fetch resource."
 *  - Safari:   "Load failed" */
const NETWORK_ERROR_MESSAGES = Object.freeze([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
]);

export const isNetworkError = (error: unknown): boolean => {
  if (CriticalQueryTimeoutError.is(error)) {
    return true;
  }
  if (APIError.is(error)) {
    return error.status === 0;
  }
  return (
    error instanceof TypeError && NETWORK_ERROR_MESSAGES.includes(error.message)
  );
};
