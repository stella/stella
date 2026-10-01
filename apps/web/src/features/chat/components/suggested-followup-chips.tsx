import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import {
  SuggestedActions,
  type SuggestedActionSurfaceName,
} from "@/components/suggested-actions";

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
 * The scroll-to-bottom action is not part of this row: it sits in the
 * composer's status row (`ChatComposerDock`).
 */
export const SuggestedFollowupChips = ({
  className,
  onSelect,
  prompts,
  surface,
}: SuggestedFollowupChipsProps) => {
  const t = useTranslations();

  if (prompts.length === 0) {
    return null;
  }

  return (
    <div className={cn("max-w-full pb-2", className)}>
      <SuggestedActions
        actions={prompts.map((prompt) => ({ id: prompt, label: prompt }))}
        label={t("chat.suggestedFollowupsLabel")}
        onSelect={onSelect}
        orientation="horizontal"
        surface={surface ?? "overlay"}
      />
    </div>
  );
};
