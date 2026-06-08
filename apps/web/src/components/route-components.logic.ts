import { APIError } from "@/lib/errors";
import { CriticalQueryTimeoutError } from "@/lib/react-query";

/** Network errors that indicate a transient connectivity
 *  issue (API down, DNS failure, etc.).
 *  Message varies by browser engine:
 *  - Chromium: "Failed to fetch"
 *  - Firefox:  "NetworkError when attempting to fetch resource."
 *  - Safari:   "Load failed" */
const NETWORK_ERROR_MESSAGES = new Set([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
]);

export const isNetworkError = (error: unknown): boolean =>
  CriticalQueryTimeoutError.is(error) ||
  (APIError.is(error) && error.status === 0) ||
  (error instanceof TypeError && NETWORK_ERROR_MESSAGES.has(error.message));
