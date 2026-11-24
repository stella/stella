import { useId, useRef } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { FollowUpIcon } from "@stll/ui/icons";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import type { FollowupSurface } from "@/lib/analytics/types";
import type { ChatThreadId } from "@/lib/chat-thread-ref-types";

/** More than three reads as a menu to scan, not a next step to take. */
const MAX_FOLLOWUPS = 3;

export type SuggestedFollowupsProps = {
  analyticsSurface: FollowupSurface;
  /** The answer the suggestions continue; it keys the shown set. */
  messageId: string;
  /**
   * Called when a suggestion is chosen. The caller sets the composer content
   * and submits through `controller.submit`, so the normal `clearDraft` /
   * `clearContent` path runs.
   */
  onSelect: (prompt: string) => void;
  /** Prompts already gated by `resolveSuggestedPromptsAvailability`. */
  prompts: readonly string[];
  threadId: ChatThreadId;
};

/**
 * What to ask next, at the end of the answer it follows: a small heading and
 * up to three quiet rows that wrap like text. They sit in the transcript's
 * flow after the answer's actions, so they never float over the answer or
 * scroll sideways above the composer.
 */
export const SuggestedFollowups = ({
  analyticsSurface,
  messageId,
  onSelect,
  prompts,
  threadId,
}: SuggestedFollowupsProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const headingId = useId();
  const shownSuggestionSetsRef = useRef(new Set<string>());
  const shown = prompts.slice(0, MAX_FOLLOWUPS);
  // Dedupe stays client-side: the thread keys the shown set, never an event.
  const suggestionSetKey = `${threadId}:${messageId}:${JSON.stringify(shown)}`;

  useExternalSyncEffect(() => {
    if (
      shown.length === 0 ||
      shownSuggestionSetsRef.current.has(suggestionSetKey)
    ) {
      return;
    }
    shownSuggestionSetsRef.current.add(suggestionSetKey);
    analytics.captureFollowupShown({
      count: shown.length,
      source: "generated",
      surface: analyticsSurface,
    });
  }, [analytics, analyticsSurface, shown.length, suggestionSetKey]);

  if (shown.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1 pt-3"
      data-chat-follow-ups=""
    >
      <h3 className="text-muted-foreground text-xs font-medium" id={headingId}>
        {t("chat.nextSteps")}
      </h3>
      <ul className="flex flex-col">
        {shown.map((prompt, index) => (
          // The message keys each row, so the next answer's set is new rows
          // even when it has as many prompts; the position is what we measure.
          <li key={`${messageId}:${String(index)}`}>
            <Button
              // The row's padding sits outside the column, so its arrow lines
              // up with the answer's text above it.
              className="-ms-3"
              layout="wrap"
              onClick={() => {
                const selected =
                  shown.at(index) ??
                  panic(`Unknown suggested follow-up index: ${String(index)}`);
                analytics.captureFollowupSelected({
                  index,
                  source: "generated",
                  surface: analyticsSurface,
                  via: "row",
                });
                onSelect(selected);
              }}
              variant="muted"
            >
              <DirectionalIcon icon={FollowUpIcon} />
              <span dir="auto">{prompt}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
};
