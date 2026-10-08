import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";

import type { TanStackAIProvider } from "@stll/ai-catalog";

import { isRecord } from "@/api/lib/type-guards";

// A model's signed reasoning is replayed to the provider that signed it and to
// no other. The signature is an opaque value only its issuer can verify: a
// thread that changes provider keeps the reasoning in its history, and an
// adapter that sends back every signed thinking entry (Anthropic's) would
// hand its provider a signature it never issued, which it refuses.
//
// A thinking entry carries no record of who wrote it, but an adapter that
// returns signed reasoning in a format of its own marks the issuer: OpenAI's
// Responses adapter packs the reasoning item's id and encrypted content as a
// JSON object (`packResponsesReasoningSignature`). Anthropic's signature is
// the opaque string its API streamed, recognizable only as not being one of
// those. Gemini keeps its thought signatures on the tool call, where only its
// own adapter reads them. The other adapters (Bedrock Converse included)
// neither return signed reasoning nor send any back.

/** A signature format that names the provider whose adapter wrote it. */
type RecognizedSignatureFormat = "openai-responses";

/**
 * The recognized format each provider's adapter sends back, or `null` when it
 * sends none. A provider added to the catalog fails typecheck here until its
 * adapter's reasoning replay is decided.
 */
const REPLAYED_SIGNATURE_FORMAT = {
  anthropic: null,
  bedrock: null,
  google: null,
  mistral: null,
  openai: "openai-responses",
  openrouter: null,
} as const satisfies Record<
  TanStackAIProvider,
  RecognizedSignatureFormat | null
>;

const recognizedFormatOf = (
  signature: string,
): RecognizedSignatureFormat | null => {
  const parsed = Result.try((): unknown => JSON.parse(signature));
  return Result.isOk(parsed) &&
    isRecord(parsed.value) &&
    (typeof parsed.value["id"] === "string" ||
      typeof parsed.value["encrypted_content"] === "string")
    ? "openai-responses"
    : null;
};

/** Whether `signature` was written by another provider's adapter. */
const isForeignSignature = (
  signature: string | undefined,
  accepted: RecognizedSignatureFormat | null,
): boolean => {
  if (signature === undefined || signature === "") {
    return false;
  }
  const format = recognizedFormatOf(signature);
  return format !== null && format !== accepted;
};

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
const withoutThinking = (message: ModelMessage): ModelMessage => {
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
const withResponsesReasoningPairedToCalls = (
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

/**
 * `messages` as `provider` may be sent them: a thinking entry signed in
 * another provider's recognized format is left out. Every other entry stays
 * for the adapter, which replays only a signature in its own form, and for
 * OpenAI only where the reasoning can stay paired with its calls.
 */
export const withReasoningBoundToProvider = (
  messages: readonly ModelMessage[],
  provider: TanStackAIProvider,
): ModelMessage[] => {
  const accepted: RecognizedSignatureFormat | null =
    REPLAYED_SIGNATURE_FORMAT[provider];
  const bound = messages.map((message) => {
    const { thinking } = message;
    if (thinking === undefined) {
      return message;
    }
    const kept = thinking.filter(
      ({ signature }) => !isForeignSignature(signature, accepted),
    );
    if (kept.length === thinking.length) {
      return message;
    }
    const { thinking: _foreign, ...rest } = message;
    return kept.length === 0 ? rest : { ...rest, thinking: kept };
  });
  return accepted === "openai-responses"
    ? withResponsesReasoningPairedToCalls(bound)
    : bound;
};
