import { getModelReasoningCapabilities } from "@stll/ai-catalog";
import type {
  ReasoningProvenance,
  ReasoningReplayFormat,
  TanStackAIProvider,
} from "@stll/ai-catalog";

import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { reasoningProvenanceForSignature } from "@/api/lib/chat/reasoning-provenance";
import { isRecord } from "@/api/lib/type-guards";

type StampReasoningProvenanceOptions<
  TMessage extends { id: string; parts: ChatPart[] },
> = {
  message: TMessage;
  model: { provider: TanStackAIProvider; modelId: string };
  initialMessages: readonly ChatMessage[];
};

/** Stamp only output created by this run; missing historical provenance stays missing. */
export const stampReasoningProvenance = <
  TMessage extends { id: string; parts: ChatPart[] },
>({
  message,
  model,
  initialMessages,
}: StampReasoningProvenanceOptions<TMessage>): TMessage => {
  const known = getModelReasoningCapabilities(model.modelId) !== null;
  const previousThinking = initialMessages.flatMap(({ parts }) =>
    parts.filter((part) => part.type === "thinking"),
  );
  const owningMessageThinking = initialMessages
    .filter((initial) => initial.id === message.id)
    .flatMap(({ parts }) => parts.filter((part) => part.type === "thinking"));
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
        !known ||
        model.provider !== "google" ||
        !isRecord(part.metadata) ||
        typeof part.metadata["thoughtSignature"] !== "string"
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
    const provenance = reasoningProvenanceForSignature({
      provider: model.provider,
      modelId: model.modelId,
      ...(part.signature === undefined ? {} : { signature: part.signature }),
    });
    return provenance === undefined ? part : { ...part, provenance };
  });
  return { ...message, parts };
};
