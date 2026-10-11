import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

/**
 * Whether an OpenAI Responses signature names a reasoning item without
 * carrying its encrypted content. The adapter then replays the item by id
 * alone, which the API can resolve only from its own stored copy: a request
 * where that copy is not kept (`store` false, or an organization that keeps
 * no data) is refused as naming an item it cannot find.
 */
const isResponsesReasoningByIdOnly = (
  signature: string | undefined,
): boolean => {
  if (signature === undefined || signature === "") {
    return false;
  }
  const parsed = Result.try((): unknown => JSON.parse(signature));
  if (!Result.isOk(parsed) || !isRecord(parsed.value)) {
    return false;
  }
  const { id } = parsed.value;
  const encrypted = parsed.value["encrypted_content"];
  return (
    typeof id === "string" &&
    id !== "" &&
    (typeof encrypted !== "string" || encrypted === "")
  );
};

/** The reasoning item id an OpenAI Responses signature replays, if any. */
const responsesReasoningIdOf = (
  signature: string | undefined,
): string | undefined => {
  if (signature === undefined || signature === "") {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(signature));
  if (!Result.isOk(parsed) || !isRecord(parsed.value)) {
    return undefined;
  }
  const id = parsed.value["id"];
  return typeof id === "string" && id !== "" ? id : undefined;
};

/**
 * The message without its reasoning, and its calls without the item ids that
 * paired them with it: a call that keeps its item id but not its reasoning is
 * refused as missing that reasoning. Without an id it is sent as a new item.
 */
export const withoutThinking = (message: ModelMessage): ModelMessage => {
  const { thinking: _unpaired, ...rest } = message;
  if (rest.toolCalls === undefined) {
    return rest;
  }
  return {
    ...rest,
    toolCalls: rest.toolCalls.map((call) => {
      if (call.metadata === undefined || !isRecord(call.metadata)) {
        return call;
      }
      const { itemId: _paired, ...metadata } = call.metadata;
      const { metadata: _withId, ...unpaired } = call;
      return Object.keys(metadata).length === 0
        ? unpaired
        : { ...unpaired, metadata };
    }),
  };
};

/**
 * The Responses API takes a replayed reasoning item only directly before the
 * item it led to. The adapter keeps a function call's item id, which pairs it
 * with the reasoning before it, only when its assistant message replays
 * exactly one reasoning item; otherwise it still sends the reasoning items
 * but drops the call's id, and the API rejects the reasoning as missing its
 * following item. A message whose calls would lose that pairing is sent
 * without its reasoning instead, mirroring the adapter's own rule (an id
 * already replayed earlier in the request counts but is not sent again).
 */
export const withResponsesReasoningPairedToCalls = (
  messages: readonly ModelMessage[],
): ModelMessage[] => {
  const replayedIds = new Set<string>();
  return messages.map((message) => {
    const { thinking } = message;
    if (message.role !== "assistant" || thinking === undefined) {
      return message;
    }
    // A reasoning item is sent only whole, and only before an item it led to:
    // one replayed by id alone may name an item the API does not keep, and
    // one with no call or text after it in its message has no following item.
    const followed =
      (message.toolCalls?.length ?? 0) > 0 ||
      (message.content !== null &&
        message.content !== "" &&
        !(Array.isArray(message.content) && message.content.length === 0));
    if (
      !followed ||
      thinking.some(({ signature }) => isResponsesReasoningByIdOnly(signature))
    ) {
      return withoutThinking(message);
    }
    const ids = thinking
      .map(({ signature }) => responsesReasoningIdOf(signature))
      .filter((id) => id !== undefined);
    const emitted = ids.filter((id) => !replayedIds.has(id));
    const hasCalls = (message.toolCalls?.length ?? 0) > 0;
    const pairs =
      ids.length === 0 || (ids.length === 1 && emitted.length === 1);
    if (hasCalls && !pairs) {
      return withoutThinking(message);
    }
    for (const id of emitted) {
      replayedIds.add(id);
    }
    return message;
  });
};
