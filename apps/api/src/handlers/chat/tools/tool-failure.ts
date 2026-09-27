import type { ChatToolError } from "@/api/lib/errors/tagged-errors";

/**
 * Report a chat tool failure. TanStack AI reads a failure only from the error
 * a tool's server function throws, so tools keep `Result`s and raise here.
 */
export const raiseChatToolError = (error: ChatToolError): never => {
  throw error;
};
