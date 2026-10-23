import type { ApiValidationIssue } from "@stll/api-contract";

/**
 * Failures the HTTP layer itself decides, before or after a handler runs.
 * `answerRequestError` turns each into its sanitized answer; nothing here
 * carries the rejected value, which may hold document content or credentials.
 */
export const HTTP_FAILURE = {
  /** The body could not be read as its declared content type. */
  malformed: "malformed",
  /** The request did not satisfy its route's schema. */
  invalidRequest: "invalid_request",
  /** The handler's answer did not satisfy its declared response schema. */
  invalidResponse: "invalid_response",
  /** No route serves this path. */
  notFound: "not_found",
  /** A route serves this path, but not with this method. */
  methodNotAllowed: "method_not_allowed",
} as const;

export type HttpFailureKind = (typeof HTTP_FAILURE)[keyof typeof HTTP_FAILURE];

export class HttpFailureError extends Error {
  readonly kind: HttpFailureKind;
  readonly issues: readonly ApiValidationIssue[] | undefined;
  /** Methods the path does serve, for a 405 `Allow` header. */
  readonly allow: readonly string[] | undefined;

  constructor(
    kind: HttpFailureKind,
    {
      issues,
      allow,
      cause,
    }: {
      issues?: readonly ApiValidationIssue[];
      allow?: readonly string[];
      cause?: unknown;
    } = {},
  ) {
    super(kind, cause === undefined ? undefined : { cause });
    this.name = "HttpFailureError";
    this.kind = kind;
    this.issues = issues;
    this.allow = allow;
  }
}

export const isHttpFailure = (error: unknown): error is HttpFailureError =>
  error instanceof HttpFailureError;

/**
 * Failures decided before the handler ran, from the request alone. Budgets
 * keep their charge for these: the caller spent the request.
 */
export const isEarlyHttpFailure = (error: unknown): boolean =>
  isHttpFailure(error) && error.kind !== HTTP_FAILURE.invalidResponse;
