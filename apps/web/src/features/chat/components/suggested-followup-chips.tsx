import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import {
  ConversationScrollButton,
  isScrollActionVisible,
} from "@/components/ai-elements/conversation";
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
 *
 * The inline scroll-to-bottom action overlays the row's trailing end (over
 * the chips' fade-out) rather than taking a leading slot, so the first chip
 * starts flush with the composer's leading edge whether or not the action
 * is showing.
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
  // While the action overlays the row's inline end, the row reserves that
  // footprint so the last chip can scroll clear of it. `pe-11` covers the
  // action's 44px coarse-pointer hit area, not only its 28px circle.
  const reserveScrollAction =
    stickToBottom !== null && isScrollActionVisible(stickToBottom);

  return (
    <div className={cn("relative max-w-full pb-2", className)}>
      <SuggestedActions
        actions={prompts.map((prompt) => ({ id: prompt, label: prompt }))}
        className={cn(reserveScrollAction && "pe-11")}
        label={t("chat.suggestedFollowupsLabel")}
        onSelect={onSelect}
        orientation="horizontal"
        surface={resolvedSurface}
      />
      {stickToBottom !== null && (
        <ConversationScrollButton
          className="absolute end-0 top-0"
          placement="inline"
          surface={resolvedSurface}
        />
      )}
    </div>
  );
};
