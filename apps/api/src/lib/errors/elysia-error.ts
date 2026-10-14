/**
 * Sanitized answers for the errors Elysia raises itself, before or after a
 * handler runs.
 *
 * Elysia serializes `error.message` by default, which for a validation
 * failure carries the rejected value, so every answer here is a fixed
 * string.
 */

import { ValidationError } from "elysia";

import type {
  ApiValidationConstraint,
  ApiValidationIssue,
} from "@stll/api-contract";

import { isResponseValidationError } from "@/api/lib/errors/response-validation";
import type { FrameworkFailure } from "@/api/lib/observability/failure";

const ELYSIA_ERROR_CODE = {
  validation: "VALIDATION",
  notFound: "NOT_FOUND",
  parse: "PARSE",
} as const;

type ElysiaErrorAnswer = {
  status: number;
  message: string;
  /** Which request fields failed and why; never the rejected values. */
  issues?: readonly ApiValidationIssue[] | undefined;
};

// One rejected request answers with a bounded list; Elysia itself stops at 64.
const MAX_VALIDATION_ISSUES = 20;

const lengthBound = (schema: unknown, key: "maxLength" | "minLength") => {
  if (typeof schema !== "object" || schema === null || !(key in schema)) {
    return undefined;
  }
  const bound: unknown = Reflect.get(schema, key);
  return typeof bound === "number" ? bound : undefined;
};

const issueFor = (
  path: string,
  schema: unknown,
  value: unknown,
): ApiValidationIssue => {
  const field = path.replace(/^\//u, "").replaceAll("/", ".");
  const constraint = ((): {
    constraint: ApiValidationConstraint;
    limit?: number;
  } => {
    if (value === undefined) {
      return { constraint: "required" };
    }
    if (typeof value === "string") {
      const max = lengthBound(schema, "maxLength");
      if (max !== undefined && value.length > max) {
        return { constraint: "maxLength", limit: max };
      }
      const min = lengthBound(schema, "minLength");
      if (min !== undefined && value.length < min) {
        return { constraint: "minLength", limit: min };
      }
    }
    return { constraint: "invalid" };
  })();
  return { field, ...constraint };
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
  for (const { path, schema, value } of error.all) {
    const issue = issueFor(path, schema, value);
    const key = `${issue.field}:${issue.constraint}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    issues.push(issue);
    if (issues.length === MAX_VALIDATION_ISSUES) {
      break;
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
  code: string | number,
  error: unknown,
): ElysiaErrorAnswer => {
  switch (code) {
    case ELYSIA_ERROR_CODE.validation:
      return isResponseValidationError(error)
        ? INTERNAL_ANSWER
        : { ...INVALID_REQUEST_ANSWER, issues: requestValidationIssues(error) };
    case ELYSIA_ERROR_CODE.notFound:
      return NOT_FOUND_ANSWER;
    case ELYSIA_ERROR_CODE.parse:
      return MALFORMED_REQUEST_ANSWER;
    default:
      return INTERNAL_ANSWER;
  }
};

/**
 * What a framework-raised error was, for the failure grader. Decided beside
 * the answer so the two cannot disagree: a response-schema failure is
 * answered 500 and observed as the handler's defect, every other validation
 * failure is the caller's. Undefined for a code the framework answers as an
 * internal error, which is graded from the error's own evidence.
 */
export const elysiaFailureReason = (
  code: string | number,
  error: unknown,
): FrameworkFailure | undefined => {
  switch (code) {
    case ELYSIA_ERROR_CODE.validation:
      return isResponseValidationError(error)
        ? "response_invalid"
        : "request_validation";
    case ELYSIA_ERROR_CODE.notFound:
      return "route_not_found";
    case ELYSIA_ERROR_CODE.parse:
      return "request_malformed";
    default:
      return undefined;
  }
};
