import { Result } from "better-result";

import {
  getModelReasoningCapabilities,
  REASONING_REPLAY_FORMATS,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import type {
  ReasoningProvenance,
  ReasoningReplayFormat,
  TanStackAIProvider,
} from "@stll/ai-catalog";

import { isRecord } from "@/api/lib/type-guards";

export const isReasoningProvenance = (
  value: unknown,
): value is ReasoningProvenance =>
  isRecord(value) &&
  TANSTACK_AI_PROVIDERS.some((provider) => provider === value["provider"]) &&
  typeof value["model"] === "string" &&
  value["model"].length > 0 &&
  REASONING_REPLAY_FORMATS.some((format) => format === value["format"]);

type ReasoningProvenanceForSignatureOptions = {
  provider: TanStackAIProvider;
  modelId: string;
  signature?: string;
};

/**
 * The replay identity of reasoning the model just produced, or undefined when
 * the catalog does not describe how this model's reasoning replays (an
 * unlisted BYOK model, for instance). Unknown reasoning is never replayed, so
 * an undefined identity is the conservative answer, not a failure.
 */
export const reasoningProvenanceForSignature = ({
  provider,
  modelId,
  signature,
}: ReasoningProvenanceForSignatureOptions): ReasoningProvenance | undefined => {
  const capabilities = getModelReasoningCapabilities(modelId);
  if (capabilities === null) {
    return undefined;
  }
  let format: ReasoningReplayFormat | undefined =
    capabilities.emittedFormats.at(0);
  if (provider === "openai" && signature !== undefined) {
    const parsed = Result.try((): unknown => JSON.parse(signature));
    if (Result.isOk(parsed) && isRecord(parsed.value)) {
      format =
        typeof parsed.value["encrypted_content"] === "string"
          ? "openai-encrypted-content"
          : "openai-item-id";
    }
  }
  return format === undefined
    ? undefined
    : { provider, model: modelId, format };
};
