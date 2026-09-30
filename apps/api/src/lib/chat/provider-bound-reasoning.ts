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
// A thinking entry carries no record of who wrote it, but each adapter that
// returns signed reasoning writes the signature in its own format, so the
// format names the issuer:
// - OpenAI's Responses adapter packs the reasoning item's id and encrypted
//   content as a JSON object (`packResponsesReasoningSignature`);
// - Anthropic's adapter keeps the signature the API streamed, an opaque
//   base64 string.
// Gemini keeps its thought signatures on the tool call, where only its own
// adapter reads them, and the other adapters return no signed reasoning.

type ReasoningSignatureFormat = "anthropic-messages" | "openai-responses";

/**
 * The signature format each provider's adapter sends back, or `null` when it
 * sends no signed reasoning to its provider. A provider added to the catalog
 * fails typecheck here until its adapter's reasoning replay is decided.
 */
const REPLAYED_SIGNATURE_FORMAT = {
  anthropic: "anthropic-messages",
  bedrock: null,
  google: null,
  mistral: null,
  openai: "openai-responses",
  openrouter: null,
} as const satisfies Record<
  TanStackAIProvider,
  ReasoningSignatureFormat | null
>;

const isOpenAiResponsesSignature = (signature: string): boolean => {
  const parsed = Result.try((): unknown => JSON.parse(signature));
  return (
    Result.isOk(parsed) &&
    isRecord(parsed.value) &&
    (typeof parsed.value["id"] === "string" ||
      typeof parsed.value["encrypted_content"] === "string")
  );
};

const signatureFormatOf = (signature: string): ReasoningSignatureFormat =>
  isOpenAiResponsesSignature(signature)
    ? "openai-responses"
    : "anthropic-messages";

/**
 * `messages` as `provider` may be sent them: a thinking entry signed in
 * another provider's format is left out. Unsigned thinking stays, since no
 * adapter replays it as a signed block.
 */
export const withReasoningBoundToProvider = (
  messages: readonly ModelMessage[],
  provider: TanStackAIProvider,
): ModelMessage[] => {
  const accepted: ReasoningSignatureFormat | null =
    REPLAYED_SIGNATURE_FORMAT[provider];
  return messages.map((message) => {
    const { thinking } = message;
    if (thinking === undefined) {
      return message;
    }
    const kept = thinking.filter(
      ({ signature }) =>
        signature === undefined ||
        signature === "" ||
        signatureFormatOf(signature) === accepted,
    );
    if (kept.length === thinking.length) {
      return message;
    }
    const { thinking: _foreign, ...rest } = message;
    return kept.length === 0 ? rest : { ...rest, thinking: kept };
  });
};
