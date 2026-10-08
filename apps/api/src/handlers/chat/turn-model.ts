import type { ReasoningEffort } from "@stll/ai-catalog";

import type {
  ChatMessage,
  ChatMessageMetadata,
} from "@/api/handlers/chat/types";

type ResolveChatTurnModelOptions = {
  messages: readonly ChatMessage[];
  owningAssistantMessageId: string | undefined;
  requestedModelId: string | undefined;
  requestedReasoningEffort: ReasoningEffort | undefined;
  /** Whether the organization can still serve a pinned model. */
  canServe: (modelId: string) => boolean;
};

/**
 * A continuation belongs to the assistant turn, even after its tools close, so
 * it keeps the model that started the turn. A turn stored before turns
 * recorded their model, or one whose provider the organization has since
 * removed, continues on the requested model: its reasoning then has no
 * compatible provenance and the closed transcript leaves it out.
 */
export const resolveChatTurnModel = ({
  messages,
  owningAssistantMessageId,
  requestedModelId,
  requestedReasoningEffort,
  canServe,
}: ResolveChatTurnModelOptions) => {
  const requested = {
    modelId: requestedModelId,
    reasoningEffort: requestedReasoningEffort,
  };
  if (owningAssistantMessageId === undefined) {
    return requested;
  }
  const owner = messages.find(({ id }) => id === owningAssistantMessageId);
  const turnModel =
    owner?.role === "assistant" ? owner.metadata?.turnModel : undefined;
  if (turnModel === undefined) {
    return requested;
  }
  const modelId = `${turnModel.provider}::${turnModel.model}`;
  if (!canServe(modelId)) {
    return requested;
  }
  return { modelId, reasoningEffort: turnModel.reasoningEffort };
};

export type ChatTurnModel = NonNullable<ChatMessageMetadata["turnModel"]>;
