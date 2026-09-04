/**
 * Sanitized answers for the errors Elysia raises itself, before or after a
 * handler runs.
 *
 * Elysia serializes `error.message` by default, which for a validation
 * failure carries the rejected value, so every answer here is a fixed
 * string.
 */

import { isResponseValidationError } from "@/api/lib/errors/response-validation";

const ELYSIA_ERROR_CODE = {
  validation: "VALIDATION",
  notFound: "NOT_FOUND",
  parse: "PARSE",
} as const;

type ElysiaErrorAnswer = {
  status: number;
  message: string;
};

const INTERNAL_ANSWER = {
  status: 500,
  message: "Internal server error",
} as const satisfies ElysiaErrorAnswer;

// Status and body are one decision, so they live in one place: a code
// answered with a client status keeps the client message that explains it.
const INVALID_REQUEST_ANSWER = {
  status: 422,
  message: "Invalid request",
} as const satisfies ElysiaErrorAnswer;
const NOT_FOUND_ANSWER = {
  status: 404,
  message: "Not found",
} as const satisfies ElysiaErrorAnswer;
const MALFORMED_REQUEST_ANSWER = {
  status: 400,
  message: "Malformed request",
} as const satisfies ElysiaErrorAnswer;

/**
 * The status and sanitized body for a framework-raised error.
 *
 * A response-schema failure is the one validation failure that is not the
 * caller's: the request satisfied its schema and the handler's output did
 * not. Answering it 422 asks the caller to fix a request that was already
 * valid, and files a server fault under the status class that is graded as
 * an answered client outcome.
 */
export const elysiaErrorAnswer = (
  code: string | number,
  error: unknown,
): ElysiaErrorAnswer => {
  switch (code) {
    case ELYSIA_ERROR_CODE.validation:
      return isResponseValidationError(error)
        ? INTERNAL_ANSWER
        : INVALID_REQUEST_ANSWER;
    case ELYSIA_ERROR_CODE.notFound:
      return NOT_FOUND_ANSWER;
    case ELYSIA_ERROR_CODE.parse:
      return MALFORMED_REQUEST_ANSWER;
    default:
      return INTERNAL_ANSWER;
  }
};
