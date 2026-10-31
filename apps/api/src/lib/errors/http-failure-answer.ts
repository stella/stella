/**
 * Sanitized answers for the failures the HTTP layer decides itself, before or
 * after a handler runs. Every answer is a fixed string: a rejected value may
 * carry document content or credentials, so none is ever echoed.
 */

import { API_VALIDATION_ERROR_CODE } from "@stll/api-contract";
import type { ApiValidationIssue } from "@stll/api-contract";
import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";

import { HTTP_FAILURE, isHttpFailure } from "@/api/http/errors";
import type { HttpFailureKind } from "@/api/http/errors";
import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { httpError } from "@/api/lib/errors/http-error";
import type { FrameworkFailure } from "@/api/lib/observability/failure";

export type HttpFailureAnswer = {
  readonly status: number;
  readonly message: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly hint?: string;
  /** Which request fields failed and why; never the rejected values. */
  readonly issues?: readonly ApiValidationIssue[];
  /** Methods the path serves, for a 405 `Allow` header. */
  readonly allow?: readonly string[];
  /** How the failure grader files it; absent for an internal error. */
  readonly framework?: FrameworkFailure;
};

const INTERNAL_ANSWER = {
  status: 500,
  message: "Internal server error",
} as const satisfies HttpFailureAnswer;

// Status, message and grading are one decision per failure, so they live in
// one table: a client status always keeps the message that explains it.
const ANSWER_BY_KIND = {
  [HTTP_FAILURE.malformed]: {
    status: 400,
    message: "Malformed request",
    framework: "request_malformed",
  },
  [HTTP_FAILURE.invalidRequest]: {
    status: 422,
    message: "Invalid request",
    framework: "request_validation",
  },
  // The request satisfied its schema and the handler's answer did not: the
  // server's fault, answered 500 and graded as the handler's defect.
  [HTTP_FAILURE.invalidResponse]: {
    status: 500,
    message: "Internal server error",
    framework: "response_invalid",
  },
  [HTTP_FAILURE.notFound]: {
    status: 404,
    message: "Not found",
    framework: "route_not_found",
  },
  [HTTP_FAILURE.methodNotAllowed]: {
    status: 405,
    message: "Method not allowed",
    framework: "method_not_allowed",
  },
} as const satisfies Record<HttpFailureKind, HttpFailureAnswer>;

/** The status, sanitized message and grading for an error the pipeline caught. */
export const httpFailureAnswer = (error: unknown): HttpFailureAnswer => {
  if (resolveHandlerError(error)?.code === LIMITER_STORE_UNAVAILABLE.code) {
    return LIMITER_STORE_UNAVAILABLE;
  }
  if (!isHttpFailure(error)) {
    return INTERNAL_ANSWER;
  }
  const answer = ANSWER_BY_KIND[error.kind];
  return {
    ...answer,
    ...(error.kind === HTTP_FAILURE.invalidRequest && error.issues !== undefined
      ? { issues: error.issues }
      : {}),
    ...(error.allow === undefined ? {} : { allow: error.allow }),
  };
};

/**
 * The JSON body for an answer: the sanitized message, plus the failing fields
 * when a request failed its schema. Every place that answers a pipeline
 * failure sends this, so the shape cannot drift.
 */
export const httpFailureBody = ({
  message,
  issues,
  code,
  retryable,
  hint,
}: HttpFailureAnswer) => {
  if (code !== undefined) {
    return { ...httpError(message, code), retryable, hint };
  }
  if (issues !== undefined && issues.length > 0) {
    return { ...httpError(message, API_VALIDATION_ERROR_CODE), issues };
  }
  return httpError(message);
};
