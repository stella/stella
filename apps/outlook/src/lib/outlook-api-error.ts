import { TaggedError } from "better-result";

export class OutlookAPIError extends TaggedError("OutlookAPIError")<{
  status: number;
  message: string;
}> {}

const SERVER_ERROR_THRESHOLD = 500;

/** A server error's own text is not for people; a refusal's text is. */
export const outlookUserErrorMessage = (
  error: OutlookAPIError,
  fallback: string,
): string =>
  error.status >= SERVER_ERROR_THRESHOLD ? fallback : error.message;
