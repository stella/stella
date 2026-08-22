import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import { ConversationScrollButton } from "@/components/ai-elements/conversation";
import { SuggestedActions } from "@/components/suggested-actions";
import { useMaybeStickToBottomContext } from "@/hooks/use-stick-to-bottom";

type SuggestedFollowupChipsProps = {
  className?: string;
  /**
   * Called when a chip is clicked. The caller is responsible for setting the
   * editor content and submitting via `controller.submit` so the normal
   * `clearDraft` / `clearContent` path runs.
   */
  onSelect: (prompt: string) => void;
  /** Prompts already gated by `resolveSuggestedPromptsAvailability`. */
  prompts: string[];
  /**
   * Chip backdrop. `overlay` (default) suits chips floating over document
   * text; `plain` suits chips rendered on a solid surface such as inside the
   * thread card, where the card already separates them from the document.
   */
  surface?: "plain" | "overlay";
};

/**
 * Suggested follow-up prompts, shown as a single horizontally scrolling row
 * after the shared availability policy supplies prompts. Placement is the
 * caller's choice: `surface="overlay"` (default) for a row floating above the
 * composer, or `surface="plain"` when rendered inside the thread card so the
 * chips sit within the chat window.
 */
export const SuggestedFollowupChips = ({
  className,
  onSelect,
  prompts,
  surface,
}: SuggestedFollowupChipsProps) => {
  const t = useTranslations();
  const stickToBottom = useMaybeStickToBottomContext();

  if (prompts.length === 0) {
    return null;
  }

  const resolvedSurface = surface ?? "overlay";

  return (
    <div className={cn("flex max-w-full items-start gap-1.5 pb-2", className)}>
      {stickToBottom !== null && (
        <ConversationScrollButton
          placement="inline"
          surface={resolvedSurface}
        />
      )}
      <SuggestedActions
        actions={prompts.map((prompt) => ({ id: prompt, label: prompt }))}
        className="min-w-0 flex-1"
        label={t("chat.suggestedFollowupsLabel")}
        onSelect={onSelect}
        orientation="horizontal"
        surface={resolvedSurface}
      />
    </div>
  );
};
