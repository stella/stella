import { SuggestedActions } from "@/components/suggested-actions";

// A user + assistant exchange is the minimum to have something to suggest from.
const SUGGESTIONS_MIN_MESSAGE_COUNT = 2;

type SuggestedFollowupChipsProps = {
  isGenerating: boolean;
  isEmpty: boolean;
  lastMessageId: string | null;
  lastMessageRole: "user" | "assistant" | "system" | "tool" | null;
  messageCount: number;
  prompts: string[];
  /**
   * Called when a chip is clicked. The caller is responsible for setting the
   * editor content and submitting via `controller.submit` so the normal
   * `clearDraft` / `clearContent` path runs.
   */
  onSelect: (prompt: string) => void;
};

/**
 * Suggested follow-up prompts above the chat composer, shown as a single
 * horizontally scrolling row when the composer is empty, the AI has just
 * responded, and no generation is in progress. They disappear once the user
 * starts typing or submits a message.
 */
export const SuggestedFollowupChips = ({
  isGenerating,
  isEmpty,
  lastMessageId,
  lastMessageRole,
  messageCount,
  prompts,
  onSelect,
}: SuggestedFollowupChipsProps) => {
  const eligible =
    isEmpty &&
    !isGenerating &&
    lastMessageId !== null &&
    lastMessageRole === "assistant" &&
    messageCount >= SUGGESTIONS_MIN_MESSAGE_COUNT;

  if (!eligible) {
    return null;
  }

  return (
    <SuggestedActions
      actions={prompts.map((prompt) => ({ id: prompt, label: prompt }))}
      className="pb-2"
      label="Suggested follow-up prompts"
      onSelect={onSelect}
      orientation="horizontal"
      surface="overlay"
    />
  );
};
