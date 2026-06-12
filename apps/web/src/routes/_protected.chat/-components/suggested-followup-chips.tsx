import { Button } from "@stll/ui/components/button";

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
 * Shows up to 3 suggested follow-up prompt chips directly above the
 * chat composer when the composer is empty, the AI has just responded,
 * and no generation is in progress. Chips disappear once the user
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

  if (!eligible || prompts.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="Suggested follow-up prompts"
      className="flex flex-wrap gap-2 pb-2"
    >
      {prompts.map((prompt, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <Button
          className="h-auto max-w-xs truncate rounded-full px-3 py-1.5 text-xs"
          key={index}
          onClick={() => {
            onSelect(prompt);
          }}
          variant="outline"
        >
          {prompt}
        </Button>
      ))}
    </div>
  );
};
