import * as v from "valibot";

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
  let changed = false;
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
    changed = true;
    return {
      ...message,
      parts: message.parts.filter((part) =>
        part.type === "tool-call"
          ? !repeated.has(part.id)
          : part.type !== "tool-result" || !repeated.has(part.toolCallId),
      ),
    };
  });
  return changed ? kept : messages;
};

/**
 * The provider's copy of `messages`: each tool call once, every call
 * answered right after its step, then run through the model-ingress guard,
 * so the answers it adds pass the guard like everything else the provider
 * reads.
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
      messages: answerHistoryCallsInTheirStep(withoutRepeatedCalls(messages)),
      workspaceIds,
    }),
  );
