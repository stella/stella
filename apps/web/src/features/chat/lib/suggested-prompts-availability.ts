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
  turnOwner: "ask-user" | "composer";
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
  if (turnOwner === "ask-user") {
    return { status: "blocked", reason: "turn-owned" };
  }
  if (lastMessage?.role !== "assistant") {
    return { status: "blocked", reason: "no-assistant-turn" };
  }
  return { status: "eligible", lastMessageId: lastMessage.id };
};
