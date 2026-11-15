import * as v from "valibot";

import { hasChatModelContent } from "@stll/api-contract/chat-message-content";

import { answerHistoryCallsInTheirStep } from "@/api/handlers/chat/step-answers";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { guardModelMessages } from "@/api/lib/chat/model-ingress-guard";
import type { GuardedModelMessages } from "@/api/lib/chat/model-ingress-guard";

const providerHistorySchema = v.pipe(
  v.custom<GuardedModelMessages<ChatMessage[]>>(Array.isArray),
  v.brand("GuardedProviderHistory"),
);

/** The history a chat attempt hands the provider. Mintable only by
 *  `guardProviderHistory`, so a history that skipped it fails typecheck at
 *  the dispatch. */
export type GuardedProviderHistory = v.InferOutput<
  typeof providerHistorySchema
>;

/**
 * `messages` with each tool call kept only in the first message holding it,
 * together with its results. Some stored threads repeat a call in later
 * messages of the thread, and a provider rejects a request in which a tool
 * call id occurs twice. Returns `messages` when no call repeats.
 */
export const withoutRepeatedCalls = (
  messages: readonly ChatMessage[],
): readonly ChatMessage[] => {
  const seen = new Set<string>();
  const kept = messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const repeated = new Set(
      message.parts.flatMap((part) =>
        part.type === "tool-call" && seen.has(part.id) ? [part.id] : [],
      ),
    );
    for (const part of message.parts) {
      if (part.type === "tool-call") {
        seen.add(part.id);
      }
    }
    if (repeated.size === 0) {
      return message;
    }
    return {
      ...message,
      parts: message.parts.filter((part) =>
        part.type === "tool-call"
          ? !repeated.has(part.id)
          : part.type !== "tool-result" || !repeated.has(part.toolCallId),
      ),
    };
  });
  return kept.some((message, index) => message !== messages[index])
    ? kept
    : messages;
};

const userMessageHasModelContent = (message: ChatMessage): boolean =>
  hasChatModelContent(
    message.parts.map((part) =>
      part.type === "text"
        ? { type: part.type, content: part.content }
        : { type: part.type },
    ),
  );

/**
 * `messages` without any user message that gives the model nothing to read,
 * together with the replies to it up to the next user message. A provider
 * rejects an empty user message, so a thread stored with one would fail on
 * every later turn; the send endpoint refuses new ones. Dropping the replies
 * with it keeps user and assistant turns alternating. Returns `messages`
 * when every user message has content.
 */
export const withoutContentlessUserTurns = (
  messages: readonly ChatMessage[],
): readonly ChatMessage[] => {
  let dropping = false;
  const kept = messages.filter((message) => {
    if (message.role === "user") {
      dropping = !userMessageHasModelContent(message);
    }
    return !dropping || message.role === "system";
  });
  return kept.length === messages.length ? messages : kept;
};

/**
 * The provider's copy of `messages`: no user turn without content, each tool
 * call once, every call answered right after its step, then run through the
 * model-ingress guard, so the answers it adds pass the guard like everything
 * else the provider reads.
 */
export const guardProviderHistory = ({
  messages,
  workspaceIds,
}: {
  messages: readonly ChatMessage[];
  workspaceIds: readonly SafeId<"workspace">[];
}): GuardedProviderHistory =>
  v.parse(
    providerHistorySchema,
    guardModelMessages({
      messages: answerHistoryCallsInTheirStep(
        withoutRepeatedCalls(withoutContentlessUserTurns(messages)),
      ),
      workspaceIds,
    }),
  );
