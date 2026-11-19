import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { StableExceptionKey } from "@/api/lib/observability/exception-fingerprint";
import {
  internalFailureResult,
  notFoundResult,
  structuredErrorResult,
} from "@/api/mcp/tool-utils";

export const legalFileReadError = (
  error: HandlerError,
  operation: StableExceptionKey,
) => {
  // Only these refusals are the caller's to act on; every other status is
  // this service's failure.
  if (error.status === 404) {
    return notFoundResult("File not found or not accessible");
  }
  if (error.status === 409) {
    return structuredErrorResult({
      code: "conflict",
      message: error.message,
      hint: "Read the document again to resolve its current attachments.",
      retryable: true,
    });
  }
  if (error.status === 422) {
    return structuredErrorResult({
      code: "validation_error",
      message: error.message,
      hint: "Check the original file or choose a different document.",
    });
  }
  return internalFailureResult(error, operation);
};
