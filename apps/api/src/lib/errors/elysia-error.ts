/**
 * Sanitized answers for the errors Elysia raises itself, before or after a
 * handler runs.
 *
 * Elysia serializes `error.message` by default, which for a validation
 * failure carries the rejected value, so every answer here is a fixed
 * string.
 */

import {
  ElysiaError,
  type InternalServerError,
  type NotFound,
  type ParseError,
  ValidationError,
} from "elysia";
import { IsLocalizedValidationError } from "typebox/error";
import type { TLocalizedValidationError } from "typebox/error";

import { API_VALIDATION_ERROR_CODE } from "@stll/api-contract";
import type { ApiValidationIssue } from "@stll/api-contract";

import { httpError } from "@/api/lib/errors/http-error";
import { isResponseValidationError } from "@/api/lib/errors/response-validation";
import type { FrameworkFailure } from "@/api/lib/observability/failure";

const ELYSIA_ERROR_CODE = {
  internal: "internal-server-error",
  validation: "validation",
  notFound: "not-found",
  parse: "parse",
} as const;

type ElysiaErrorCode = NonNullable<
  | InternalServerError["code"]
  | NotFound["code"]
  | ParseError["code"]
  | ValidationError["code"]
>;

const frameworkErrorCode = (
  code: unknown,
  error: unknown,
): ElysiaErrorCode | undefined => {
  const candidate =
    code ?? (error instanceof ElysiaError ? error.code : undefined);
  if (
    candidate === ELYSIA_ERROR_CODE.internal ||
    candidate === ELYSIA_ERROR_CODE.validation ||
    candidate === ELYSIA_ERROR_CODE.notFound ||
    candidate === ELYSIA_ERROR_CODE.parse
  ) {
    return candidate;
  }
  return undefined;
};

type ElysiaErrorAnswer = {
  status: number;
  message: string;
  /** Which request fields failed and why; never the rejected values. */
  issues?: readonly ApiValidationIssue[] | undefined;
};

// One rejected request answers with a bounded list; Elysia itself stops at 64.
const MAX_VALIDATION_ISSUES = 20;

const fieldAt = (path: string) => path.replace(/^\//u, "").replaceAll("/", ".");

const issueFor = (
  error: TLocalizedValidationError,
  path = error.instancePath,
): ApiValidationIssue => {
  const field = fieldAt(path);
  if (error.keyword === "maxLength") {
    return { field, constraint: "maxLength", limit: error.params.limit };
  }
  if (error.keyword === "minLength") {
    return { field, constraint: "minLength", limit: error.params.limit };
  }
  return {
    field,
    constraint: error.keyword === "required" ? "required" : "invalid",
  };
};

/**
 * The failing fields of a rejected request, deduplicated, without the values
 * that failed: those may carry document content or credentials.
 */
const requestValidationIssues = (error: unknown): ApiValidationIssue[] => {
  if (!(error instanceof ValidationError)) {
    return [];
  }
  const seen = new Set<string>();
  const issues: ApiValidationIssue[] = [];
  for (const detail of error.errors) {
    if (!IsLocalizedValidationError(detail)) {
      continue;
    }
    const paths =
      detail.keyword === "required"
        ? detail.params.requiredProperties.map(
            (property) => `${detail.instancePath}/${property}`,
          )
        : [detail.instancePath];
    for (const path of paths) {
      const issue = issueFor(detail, path);
      const key = `${issue.field}:${issue.constraint}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      issues.push(issue);
      if (issues.length === MAX_VALIDATION_ISSUES) {
        return issues;
      }
    }
  }
  return issues;
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
  code: string | number | undefined,
  error: unknown,
): ElysiaErrorAnswer => {
  const resolvedCode = frameworkErrorCode(code, error);
  if (resolvedCode === undefined) {
    return INTERNAL_ANSWER;
  }
  let answer: ElysiaErrorAnswer;
  switch (resolvedCode) {
    case ELYSIA_ERROR_CODE.validation:
      answer = isResponseValidationError(error)
        ? INTERNAL_ANSWER
        : { ...INVALID_REQUEST_ANSWER, issues: requestValidationIssues(error) };
      break;
    case ELYSIA_ERROR_CODE.notFound:
      answer = NOT_FOUND_ANSWER;
      break;
    case ELYSIA_ERROR_CODE.parse:
      answer = MALFORMED_REQUEST_ANSWER;
      break;
    case ELYSIA_ERROR_CODE.internal:
      answer = INTERNAL_ANSWER;
      break;
  }
  return answer;
};

/**
 * The JSON body for an answer: the sanitized message, plus the failing
 * fields when a request failed its schema. Every place that answers a
 * framework-raised error sends this, so the shape cannot drift.
 */
export const elysiaErrorBody = ({ message, issues }: ElysiaErrorAnswer) =>
  issues !== undefined && issues.length > 0
    ? { ...httpError(message, API_VALIDATION_ERROR_CODE), issues }
    : httpError(message);

/**
 * What a framework-raised error was, for the failure grader. Decided beside
 * the answer so the two cannot disagree: a response-schema failure is
 * answered 500 and observed as the handler's defect, every other validation
 * failure is the caller's. Undefined for a code the framework answers as an
 * internal error, which is graded from the error's own evidence.
 */
export const elysiaFailureReason = (
  code: string | number | undefined,
  error: unknown,
): FrameworkFailure | undefined => {
  const resolvedCode = frameworkErrorCode(code, error);
  if (resolvedCode === undefined) {
    return undefined;
  }
  let reason: FrameworkFailure | undefined;
  switch (resolvedCode) {
    case ELYSIA_ERROR_CODE.validation:
      reason = isResponseValidationError(error)
        ? "response_invalid"
        : "request_validation";
      break;
    case ELYSIA_ERROR_CODE.notFound:
      reason = "route_not_found";
      break;
    case ELYSIA_ERROR_CODE.parse:
      reason = "request_malformed";
      break;
    case ELYSIA_ERROR_CODE.internal:
      reason = undefined;
      break;
  }
  return reason;
};
