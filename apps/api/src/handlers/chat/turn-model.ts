import { TaggedError } from "better-result";

import type { ReasoningEffort } from "@stll/ai-catalog";

import type {
  ChatMessage,
  ChatMessageMetadata,
} from "@/api/handlers/chat/types";

export class ChatTurnModelMissingError extends TaggedError(
  "ChatTurnModelMissingError",
)<{
  message: string;
}> {}

type ResolveChatTurnModelOptions = {
  messages: readonly ChatMessage[];
  owningAssistantMessageId: string | undefined;
  requestedModelId: string | undefined;
  requestedReasoningEffort: ReasoningEffort | undefined;
};

/** A continuation belongs to the assistant turn, even after its tools close. */
export const resolveChatTurnModel = ({
  messages,
  owningAssistantMessageId,
  requestedModelId,
  requestedReasoningEffort,
}: ResolveChatTurnModelOptions) => {
  if (owningAssistantMessageId === undefined) {
    return {
      modelId: requestedModelId,
      reasoningEffort: requestedReasoningEffort,
    };
  }
  const owner = messages.find(({ id }) => id === owningAssistantMessageId);
  const turnModel = owner?.metadata?.turnModel;
  if (owner?.role !== "assistant" || turnModel === undefined) {
    throw new ChatTurnModelMissingError({
      message:
        "Cannot resume an assistant turn without its original model identity",
    });
  }
  return {
    modelId: `${turnModel.provider}::${turnModel.model}`,
    reasoningEffort: turnModel.reasoningEffort,
  };
};

export type ChatTurnModel = NonNullable<ChatMessageMetadata["turnModel"]>;
