import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { AIColumnInputRequiredError } from "@/api/lib/properties/computed-column-input";

export const computedColumnInputHandlerError = (
  error: AIColumnInputRequiredError,
) =>
  new HandlerError({
    status: 422,
    code: error.code,
    message: error.message,
    hint: `Candidate file columns: ${error.candidateFileColumnIds.join(", ") || "none"}`,
  });
