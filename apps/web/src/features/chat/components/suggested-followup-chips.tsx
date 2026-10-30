import { useRef } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import {
  SuggestedActions,
  type SuggestedActionSurfaceName,
} from "@/components/suggested-actions";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import type { FollowupSurface } from "@/lib/analytics/types";
import type { ChatThreadId } from "@/lib/chat-thread-ref";

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
  analyticsSurface: FollowupSurface;
  messageId: string;
  threadId: ChatThreadId;
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
 * Suggested follow-up prompts, shown as one row that scrolls sideways
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
  analyticsSurface,
  messageId,
  onSelect,
  prompts,
  surface,
  threadId,
}: SuggestedFollowupChipsProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const shownSuggestionSetsRef = useRef(new Set<string>());
  // Dedupe stays client-side: the thread keys the shown set, never an event.
  const suggestionSetKey = `${threadId}:${messageId}:${JSON.stringify(prompts)}`;

  useExternalSyncEffect(() => {
    if (
      prompts.length === 0 ||
      shownSuggestionSetsRef.current.has(suggestionSetKey)
    ) {
      return;
    }
    shownSuggestionSetsRef.current.add(suggestionSetKey);
    analytics.captureFollowupShown({
      count: prompts.length,
      source: "generated",
      surface: analyticsSurface,
    });
  }, [analytics, analyticsSurface, prompts.length, suggestionSetKey]);

  if (prompts.length === 0) {
    return null;
  }

  return (
    <div className={cn("max-w-full pb-2", className)}>
      <SuggestedActions
        // The message keys each chip, so the next answer's set is a new row
        // even when it has as many prompts; the position is what we measure.
        actions={prompts.map((prompt, index) => ({
          id: `${messageId}:${String(index)}`,
          label: prompt,
        }))}
        label={t("chat.suggestedFollowupsLabel")}
        onSelect={(id) => {
          const index = Number(id.slice(id.lastIndexOf(":") + 1));
          const prompt =
            prompts.at(index) ??
            panic(`Unknown suggested follow-up index: ${id}`);
          analytics.captureFollowupSelected({
            index,
            source: "generated",
            surface: analyticsSurface,
            via: "chip",
          });
          onSelect(prompt);
        }}
        // One line: a wrapped set grows by a row per chip that overflows and
        // pushes the composer's context away.
        orientation="row"
        scrollLabels={{
          next: t("common.next"),
          previous: t("common.previous"),
        }}
        surface={surface ?? "overlay"}
      />
    </div>
  );
};
