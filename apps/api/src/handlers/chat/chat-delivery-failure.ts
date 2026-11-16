import type { StreamDurability } from "@tanstack/ai";
import { Result, TaggedError } from "better-result";

import { AI_FAILURE_CODES } from "@stll/api-contract";
import type { AIErrorKind, AIFailureCode } from "@stll/api-contract";

import { classifyAIError } from "@/api/lib/ai-error";

/**
 * A failure delivering a chat turn, as the stream reports it.
 *
 * When its durability fails, the SDK ends the producer with a RUN_ERROR built
 * from the thrown error's own message and code, both on the live stream and in
 * the stored log. The chat names every failure by its AI error kind, which the
 * client reads from a RUN_ERROR's message (`aiErrorKindFromMessage`), so this
 * error carries the kind as its message and the kind's failure code as its
 * code. The failure it reports stays its cause.
 *
 * Only a size refusal names a kind of its own (`turn_too_large`). Any other
 * durability failure is the store's, whatever its cause looks like (a database
 * connection reset is not a provider outage), so it is `unknown`.
 */
export class ChatDeliveryError extends TaggedError("ChatDeliveryError")<{
  /** The kind, which is what the client reads. */
  message: string;
  kind: AIErrorKind;
  code: AIFailureCode;
  cause: unknown;
}> {}

const deliveryFailure = (error: unknown): ChatDeliveryError => {
  if (ChatDeliveryError.is(error)) {
    return error;
  }
  const kind =
    classifyAIError(error) === "turn_too_large" ? "turn_too_large" : "unknown";
  return new ChatDeliveryError({
    message: kind,
    kind,
    code: AI_FAILURE_CODES[kind],
    cause: error,
  });
};

/**
 * `durability` whose failures reach the stream only as AI error kinds, never
 * as an internal message the client cannot explain. `onFailure` learns each
 * failure, so the run can settle its turn with the same kind and observe the
 * cause the stream drops.
 */
export const reportDeliveryFailuresByKind = (
  durability: StreamDurability,
  onFailure: (failure: ChatDeliveryError) => void,
): StreamDurability => {
  const reported = (error: unknown): ChatDeliveryError => {
    const failure = deliveryFailure(error);
    onFailure(failure);
    return failure;
  };
  return {
    ...durability,
    append: async (chunks) => {
      const appended = await Result.tryPromise(
        async () => await durability.append(chunks),
      );
      if (Result.isError(appended)) {
        throw reported(appended.error.cause);
      }
      return appended.value;
    },
    close: async () => {
      const closed = await Result.tryPromise(
        async () => await durability.close(),
      );
      if (Result.isError(closed)) {
        throw reported(closed.error.cause);
      }
    },
  };
};
