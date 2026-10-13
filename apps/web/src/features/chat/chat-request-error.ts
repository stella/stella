import { TaggedError } from "better-result";

export class ChatRequestError extends TaggedError("ChatRequestError")<{
  kind:
    | "preparation_failed"
    | "connection_failed"
    | "timed_out"
    | "not_started";
  message: string;
  cause?: unknown;
}> {}

/** SDK transport wrappers retain the typed cause; replay may lose it. */
export const findChatRequestError = (
  error: unknown,
): ChatRequestError | undefined => {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (ChatRequestError.is(current)) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
};
