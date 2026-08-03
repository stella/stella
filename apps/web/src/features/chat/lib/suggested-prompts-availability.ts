import type { ChatMessage, ChatPart } from "@/components/chat/chat-ui-tools";

type SuggestedPromptsAvailability =
  | { status: "eligible"; lastMessageId: string }
  | {
      status: "blocked";
      reason:
        | "draft"
        | "error"
        | "generating"
        | "no-assistant-turn"
        | "turn-owned";
    };

type ResolveSuggestedPromptsAvailabilityOptions = {
  editorIsEmpty: boolean;
  error: Error | undefined;
  isGenerating: boolean;
  lastMessage: {
    id: string;
    role: "assistant" | "system" | "tool" | "user";
  } | null;
  turnOwner: SuggestedPromptsTurnOwner;
};

export type SuggestedPromptsTurnOwner = "approval" | "ask-user" | "composer";

type ToolCallState = Extract<ChatPart, { type: "tool-call" }>["state"];
const ASK_USER_STATE_OWNS_TURN = {
  "awaiting-input": true,
  "approval-requested": true,
  "approval-responded": false,
  complete: false,
  error: false,
  "input-complete": true,
  "input-streaming": true,
} as const satisfies Record<ToolCallState, boolean>;

type ResolveSuggestedPromptsTurnOwnerOptions = {
  approvalPendingMessageId: string | null;
  hasReopenedAskUser: boolean;
  lastMessage: ChatMessage | null;
};

export const resolveSuggestedPromptsTurnOwner = ({
  approvalPendingMessageId,
  hasReopenedAskUser,
  lastMessage,
}: ResolveSuggestedPromptsTurnOwnerOptions): SuggestedPromptsTurnOwner => {
  if (approvalPendingMessageId !== null) {
    return "approval";
  }
  if (hasReopenedAskUser) {
    return "ask-user";
  }
  if (
    lastMessage?.role === "assistant" &&
    lastMessage.parts.some(
      (part) =>
        part.type === "tool-call" &&
        part.name === "ask-user" &&
        ASK_USER_STATE_OWNS_TURN[part.state],
    )
  ) {
    return "ask-user";
  }
  return "composer";
};

export const resolveSuggestedPromptsAvailability = ({
  editorIsEmpty,
  error,
  isGenerating,
  lastMessage,
  turnOwner,
}: ResolveSuggestedPromptsAvailabilityOptions): SuggestedPromptsAvailability => {
  if (error !== undefined) {
    return { status: "blocked", reason: "error" };
  }
  if (isGenerating) {
    return { status: "blocked", reason: "generating" };
  }
  if (!editorIsEmpty) {
    return { status: "blocked", reason: "draft" };
  }
  if (turnOwner !== "composer") {
    return { status: "blocked", reason: "turn-owned" };
  }
  if (lastMessage?.role !== "assistant") {
    return { status: "blocked", reason: "no-assistant-turn" };
  }
  return { status: "eligible", lastMessageId: lastMessage.id };
};
