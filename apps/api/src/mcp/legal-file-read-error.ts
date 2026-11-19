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
  switch (error.status) {
    case 404:
      return notFoundResult("File not found or not accessible");
    case 409:
      return structuredErrorResult({
        code: "conflict",
        message: error.message,
        hint: "Read the document again to resolve its current attachments.",
        retryable: true,
      });
    case 422:
      return structuredErrorResult({
        code: "validation_error",
        message: error.message,
        hint: "Check the original file or choose a different document.",
      });
    default:
      return internalFailureResult(error, operation);
  }
};
