/**
 * Sanitized answers for the errors Elysia raises itself, before or after a
 * handler runs.
 *
 * Elysia serializes `error.message` by default, which for a validation
 * failure carries the rejected value, so every answer here is a fixed
 * string.
 */

import { ElysiaError, ValidationError } from "elysia";

import { API_VALIDATION_ERROR_CODE } from "@stll/api-contract";
import type {
  ApiValidationConstraint,
  ApiValidationIssue,
} from "@stll/api-contract";

import { httpError } from "@/api/lib/errors/http-error";
import { isResponseValidationError } from "@/api/lib/errors/response-validation";
import type { FrameworkFailure } from "@/api/lib/observability/failure";

const ELYSIA_ERROR_CODE = {
  validation: ["VALIDATION", "validation"],
  notFound: ["NOT_FOUND", "not-found"],
  parse: ["PARSE", "parse"],
} as const;

const frameworkErrorCode = (code: unknown, error: unknown) =>
  code ?? (error instanceof ElysiaError ? error.code : undefined);

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
  required: boolean,
): ApiValidationIssue => {
  const field = path.replace(/^\//u, "").replaceAll("/", ".");
  const constraint = ((): {
    constraint: ApiValidationConstraint;
    limit?: number;
  } => {
    if (required) {
      return { constraint: "required" };
    }
    const max = lengthBound(schema, "maxLength");
    if (max !== undefined) {
      return { constraint: "maxLength", limit: max };
    }
    const min = lengthBound(schema, "minLength");
    if (min !== undefined) {
      return { constraint: "minLength", limit: min };
    }
    return { constraint: "invalid" };
  })();
  return { field, ...constraint };
};

const schemaAtPath = (schema: unknown, path: string): unknown => {
  let current = schema;
  for (const segment of path.replace(/^\//u, "").split("/")) {
    if (segment === "" || typeof current !== "object" || current === null) {
      return current;
    }
    const properties: unknown = Reflect.get(current, "properties");
    if (typeof properties !== "object" || properties === null) {
      return current;
    }
    current = Reflect.get(properties, segment);
  }
  return current;
};

const requiredProperties = (params: unknown): readonly string[] => {
  if (typeof params !== "object" || params === null) {
    return [];
  }
  const required: unknown = Reflect.get(params, "requiredProperties");
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === "string")
    : [];
};

const validationDetails = (details: unknown): readonly unknown[] =>
  Array.isArray(details) ? details : [];

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
  for (const detail of validationDetails(error.all)) {
    if (typeof detail !== "object" || detail === null) {
      continue;
    }
    const path: unknown = Reflect.get(detail, "path");
    if (typeof path !== "string") {
      continue;
    }
    const params: unknown = Reflect.get(detail, "params");
    const required = requiredProperties(params);
    const paths = required.length > 0 ? required : [path];
    for (const issuePath of paths) {
      const issue = issueFor(
        issuePath,
        schemaAtPath(error.schema, issuePath),
        required.length > 0,
      );
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
  switch (resolvedCode) {
    case ELYSIA_ERROR_CODE.validation[0]:
    case ELYSIA_ERROR_CODE.validation[1]:
      return isResponseValidationError(error)
        ? INTERNAL_ANSWER
        : { ...INVALID_REQUEST_ANSWER, issues: requestValidationIssues(error) };
    case ELYSIA_ERROR_CODE.notFound[0]:
    case ELYSIA_ERROR_CODE.notFound[1]:
      return NOT_FOUND_ANSWER;
    case ELYSIA_ERROR_CODE.parse[0]:
    case ELYSIA_ERROR_CODE.parse[1]:
      return MALFORMED_REQUEST_ANSWER;
    default:
      return INTERNAL_ANSWER;
  }
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
  switch (resolvedCode) {
    case ELYSIA_ERROR_CODE.validation[0]:
    case ELYSIA_ERROR_CODE.validation[1]:
      return isResponseValidationError(error)
        ? "response_invalid"
        : "request_validation";
    case ELYSIA_ERROR_CODE.notFound[0]:
    case ELYSIA_ERROR_CODE.notFound[1]:
      return "route_not_found";
    case ELYSIA_ERROR_CODE.parse[0]:
    case ELYSIA_ERROR_CODE.parse[1]:
      return "request_malformed";
    default:
      return undefined;
  }
};
