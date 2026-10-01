import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import { ConversationScrollButton } from "@/components/ai-elements/conversation";
import {
  SuggestedActions,
  type SuggestedActionSurfaceName,
} from "@/components/suggested-actions";
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
   * text that a composer veil already softens behind them; `floating` is
   * opaque, for chips floating over unveiled transcript text; `plain` suits
   * chips rendered on a solid surface such as inside the thread card, where
   * the card already separates them from the document.
   */
  surface?: SuggestedActionSurfaceName;
};

/**
 * Suggested follow-up prompts, shown as a single horizontally scrolling row
 * after the shared availability policy supplies prompts. Placement is the
 * caller's choice: `surface="overlay"` (default) for a row floating above the
 * composer on a veiled docked column, `surface="floating"` where no veil sits
 * behind the row, or `surface="plain"` when rendered inside the thread card so
 * the chips sit within the chat window.
 *
 * The scroll action floats centered above the row, where it sits when no
 * chips show, and appears only where a stick-to-bottom context surrounds
 * the row.
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

  return (
    <div className={cn("relative max-w-full pb-2", className)}>
      <SuggestedActions
        actions={prompts.map((prompt) => ({ id: prompt, label: prompt }))}
        label={t("chat.suggestedFollowupsLabel")}
        onSelect={onSelect}
        orientation="horizontal"
        surface={surface ?? "overlay"}
      />
      {/* The conversation's own scroll action is hidden while this row
          shows, so the row carries it: centered just above the chips, where
          it sits without them, never over a chip. */}
      {stickToBottom !== null && (
        <ConversationScrollButton className="bottom-full mb-2" />
      )}
    </div>
  );
};
