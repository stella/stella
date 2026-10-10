// parser-output-unchanged: This change only redacts query parameters from error output and does not change parser output.
import { TaggedError } from "better-result";

export { createDetached, type DetachedRejectionSink } from "./detached";
export {
  createDevErrorLogger,
  type CreateDevErrorLoggerOptions,
  type DevErrorSink,
} from "./dev-error";
export {
  classifyFailure,
  declareFailureClass,
  FAILURE_GRADES,
  FAILURE_REASON_GRADE,
  failureGradeOf,
  isFailureReason,
  MISCONFIGURATION_REASONS,
  readFailureBrand,
  type FailureBrand,
  type FailureGrade,
  type FailureReason,
} from "./failure";

/**
 * HTTP/network failure at a raw fetch boundary. Carries protocol details for
 * structured logging while keeping callers free to wrap user-facing messages.
 */
export class FetchBoundaryError extends TaggedError("FetchBoundaryError")<{
  url: string;
  status?: number;
  statusText?: string;
  body?: string;
  message: string;
  cause?: unknown;
}> {}

export {
  sanitizeErrorForOutput,
  sanitizeErrorAttributesForOutput,
  sanitizeQueryErrorText,
  printError,
  logErrorOutput,
  errorOutputLogger,
} from "./query-error";

export {
  isQueryErrorOutputKey,
  QUERY_ERROR_OUTPUT_FIELDS,
} from "./query-field-policy";
