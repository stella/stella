import type { ChatToolError } from "@/api/lib/errors/tagged-errors";

/**
 * Report a chat tool failure. TanStack AI reads a failure only from the error
 * a tool's server function throws, so tools keep `Result`s and raise here.
 */
export const raiseChatToolError = (error: ChatToolError): never => {
  throw error;
};

/**
 * Re-raise the failure a wrapped tool's server function threw. Wrappers that
 * audit or fence a call settle the inner function into a `Result`, then report
 * its failure back to TanStack AI through this one module.
 */
export const reraiseChatToolFailure = (error: unknown): never => {
  throw error;
};
