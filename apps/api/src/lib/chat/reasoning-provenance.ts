import { panic, Result } from "better-result";

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

import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { isRecord } from "@/api/lib/type-guards";

export const isReasoningProvenance = (
  value: unknown,
): value is ReasoningProvenance =>
  isRecord(value) &&
  TANSTACK_AI_PROVIDERS.some((provider) => provider === value["provider"]) &&
  typeof value["model"] === "string" &&
  value["model"].length > 0 &&
  REASONING_REPLAY_FORMATS.some((format) => format === value["format"]);

type StampReasoningProvenanceOptions<
  TMessage extends { id: string; parts: ChatPart[] },
> = {
  message: TMessage;
  model: { provider: TanStackAIProvider; modelId: string };
  initialMessages: readonly ChatMessage[];
};

type ReasoningProvenanceForSignatureOptions = {
  provider: TanStackAIProvider;
  modelId: string;
  signature?: string;
};

export const reasoningProvenanceForSignature = ({
  provider,
  modelId,
  signature,
}: ReasoningProvenanceForSignatureOptions): ReasoningProvenance => {
  const capabilities = getModelReasoningCapabilities(modelId);
  if (capabilities === null) {
    return panic(`Missing reasoning capabilities for ${modelId}`);
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
  if (format === undefined) {
    return panic(`Missing emitted reasoning format for ${modelId}`);
  }
  return { provider, model: modelId, format };
};

/** Stamp only output created by this run; missing historical provenance stays missing. */
export const stampReasoningProvenance = <
  TMessage extends { id: string; parts: ChatPart[] },
>({
  message,
  model,
  initialMessages,
}: StampReasoningProvenanceOptions<TMessage>): TMessage => {
  const capabilities = getModelReasoningCapabilities(model.modelId);
  if (capabilities === null) {
    return panic(`Missing reasoning capabilities for ${model.modelId}`);
  }
  const previousThinking = initialMessages.flatMap(({ parts }) =>
    parts.filter((part) => part.type === "thinking"),
  );
  const owningMessageThinking =
    initialMessages
      .find((initial) => initial.id === message.id)
      ?.parts.filter((part) => part.type === "thinking") ?? [];
  let thinkingIndex = 0;
  const previousCalls = new Set(
    initialMessages.flatMap(({ parts }) =>
      parts.flatMap((part) => (part.type === "tool-call" ? [part.id] : [])),
    ),
  );
  const provenanceFor = (
    format: ReasoningReplayFormat,
  ): ReasoningProvenance => ({
    provider: model.provider,
    model: model.modelId,
    format,
  });
  const parts = message.parts.map((part): ChatPart => {
    if (part.type === "tool-call") {
      if (
        previousCalls.has(part.id) ||
        model.provider !== "google" ||
        typeof part.metadata?.["thoughtSignature"] !== "string"
      ) {
        return part;
      }
      return {
        ...part,
        metadata: {
          ...part.metadata,
          reasoningProvenance: provenanceFor("google-thought-signature"),
        },
      };
    }
    if (part.type !== "thinking") {
      return part;
    }
    const ownedPrevious = owningMessageThinking.at(thinkingIndex);
    thinkingIndex += 1;
    if (part.provenance !== undefined) {
      return part;
    }
    // A signature is the only identity that survives across messages. Step ids
    // and content are reused by later turns (a new turn may restart at the
    // same step id under another model), so unsigned parts adopt provenance
    // only from the message that owns them.
    const previous =
      part.signature === undefined
        ? (owningMessageThinking.find(
            (candidate) =>
              candidate.signature === undefined &&
              ((part.stepId !== undefined &&
                candidate.stepId === part.stepId) ||
                candidate.content === part.content),
          ) ??
          (ownedPrevious?.signature === undefined ? ownedPrevious : undefined))
        : previousThinking.find(
            (candidate) => candidate.signature === part.signature,
          );
    if (previous !== undefined) {
      return previous.provenance === undefined
        ? part
        : { ...part, provenance: previous.provenance };
    }
    return {
      ...part,
      provenance: reasoningProvenanceForSignature({
        provider: model.provider,
        modelId: model.modelId,
        ...(part.signature === undefined ? {} : { signature: part.signature }),
      }),
    };
  });
  return { ...message, parts };
};
