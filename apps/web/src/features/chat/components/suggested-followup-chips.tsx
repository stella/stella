import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

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
   * Chip backdrop. `overlay` (default) suits chips floating over document
   * text; `plain` suits chips rendered on a solid surface such as inside the
   * thread card, where the card already separates them from the document.
   */
  surface?: "plain" | "overlay";
  className?: string;
  /**
   * Called when a chip is clicked. The caller is responsible for setting the
   * editor content and submitting via `controller.submit` so the normal
   * `clearDraft` / `clearContent` path runs.
   */
  onSelect: (prompt: string) => void;
};

/**
 * Suggested follow-up prompts, shown as a single horizontally scrolling row
 * when the composer is empty, the AI has just responded, and no generation is
 * in progress. They disappear once the user starts typing or submits a
 * message. Placement is the caller's choice: `surface="overlay"` (default)
 * for a row floating above the composer, or `surface="plain"` when rendered
 * inside the thread card so the chips sit within the chat window.
 */
export const SuggestedFollowupChips = ({
  isGenerating,
  isEmpty,
  lastMessageId,
  lastMessageRole,
  messageCount,
  prompts,
  surface,
  className,
  onSelect,
}: SuggestedFollowupChipsProps) => {
  const t = useTranslations();
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
      className={cn("pb-2", className)}
      label={t("chat.suggestedFollowupsLabel")}
      onSelect={onSelect}
      orientation="horizontal"
      surface={surface ?? "overlay"}
    />
  );
};
