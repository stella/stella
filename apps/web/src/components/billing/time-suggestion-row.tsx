import { useTranslations } from "use-intl";

import type { TimeEntrySuggestion } from "@stll/api-contract/time-entry-types";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { CheckIcon, PencilIcon, XIcon } from "@stll/ui/icons";
import { typedCharacter } from "@stll/ui/typed-character";

import { timeEntryActionLabel } from "@/components/billing/time-entry-copy.logic";
import {
  composeSuggestionNarrative,
  suggestionEvidenceLabels,
} from "@/components/billing/time-suggestion-copy.logic";
import { useFormatter } from "@/i18n/formatting-context";
import { formatMinutes } from "@/lib/workspaces/format-duration";

const EVIDENCE_SEPARATOR = " · ";

export type TimeSuggestionRowActions = {
  onAccept: (suggestion: TimeEntrySuggestion, narrative: string) => void;
  onEdit: (suggestion: TimeEntrySuggestion, narrative: string) => void;
  onDismiss: (suggestion: TimeEntrySuggestion) => void;
};

type TimeSuggestionRowProps = TimeSuggestionRowActions & {
  suggestion: TimeEntrySuggestion;
  /** Disabled while this suggestion's own decision is in flight. */
  busy: boolean;
  /** Shown above the narrative where suggestions from several matters mix. */
  matterName?: string;
};

/**
 * One suggested entry. The row body is the accept action; Edit and Dismiss
 * keep their own buttons but also answer as shortcuts (E, Delete) while the
 * body has focus, so a keyboard pass over a day needs no pointer.
 */
export const TimeSuggestionRow = ({
  suggestion,
  busy,
  matterName,
  onAccept,
  onEdit,
  onDismiss,
}: TimeSuggestionRowProps) => {
  const t = useTranslations("billing.suggestions");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const copyLabels = {
    chatEvidence: (count: number, title: string) =>
      t("chatEvidence", { count, title }),
    unnamedRecord: t("unnamedRecord"),
  };
  const narrative = composeSuggestionNarrative(suggestion.evidence, copyLabels);
  const evidence = suggestionEvidenceLabels(
    suggestion.evidence,
    copyLabels,
  ).join(EVIDENCE_SEPARATOR);

  return (
    <li className="flex min-h-14 items-center gap-3 rounded-lg border px-3 py-2">
      <Button
        aria-keyshortcuts="Enter E Delete Backspace"
        aria-label={timeEntryActionLabel(tCommon("accept"), narrative)}
        className="flex min-w-0 flex-1"
        disabled={busy}
        onClick={() => onAccept(suggestion, narrative)}
        onKeyDown={(event) => {
          // A held key never dismisses more than one suggestion.
          if (event.repeat) {
            return;
          }
          const character = typedCharacter(event.nativeEvent);
          // Modified deletes stay with the browser and assistive technology.
          const plainDelete =
            (event.key === "Delete" || event.key === "Backspace") &&
            !(event.altKey || event.ctrlKey || event.metaKey);
          if (character === "e" || character === "E") {
            event.preventDefault();
            onEdit(suggestion, narrative);
          } else if (plainDelete) {
            event.preventDefault();
            onDismiss(suggestion);
          }
        }}
        // The shortcuts this row answers, shown on hover and on focus.
        tooltip={t("keyboardHint")}
        variant="plain"
      >
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <CheckIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {matterName !== undefined && (
              <BidiText
                as="span"
                className="text-muted-foreground block truncate text-xs"
              >
                {matterName}
              </BidiText>
            )}
            <BidiText as="span" className="block truncate text-sm font-medium">
              {narrative}
            </BidiText>
            <BidiText
              as="span"
              className="text-muted-foreground block truncate text-xs"
            >
              {format.dateTime(new Date(suggestion.startedAt), {
                timeStyle: "short",
              })}
              {" – "}
              {format.dateTime(new Date(suggestion.endedAt), {
                timeStyle: "short",
              })}
              {EVIDENCE_SEPARATOR}
              {evidence}
            </BidiText>
            <span className="text-muted-foreground block text-xs tabular-nums">
              {suggestion.alreadyCovered
                ? t("alreadyCovered")
                : t("engagedTime", {
                    duration: formatMinutes(suggestion.engagedMinutes),
                  })}
            </span>
          </span>
        </span>
      </Button>
      <span className="shrink-0 text-sm font-medium tabular-nums">
        {formatMinutes(suggestion.durationMinutes)}
      </span>
      <Button
        aria-label={timeEntryActionLabel(tCommon("edit"), narrative)}
        className="size-11"
        disabled={busy}
        onClick={() => onEdit(suggestion, narrative)}
        size="icon"
        variant="ghost"
      >
        <PencilIcon className="size-4" />
      </Button>
      <Button
        aria-label={timeEntryActionLabel(tCommon("dismiss"), narrative)}
        className="size-11"
        disabled={busy}
        onClick={() => onDismiss(suggestion)}
        size="icon"
        variant="destructive-ghost"
      >
        <XIcon className="size-4" />
      </Button>
    </li>
  );
};
