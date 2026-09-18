import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import type { TimeEntrySuggestion } from "@stll/api-contract/time-entry-types";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";

import { formatMinutes } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-duration";
import { timeEntryActionLabel } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-copy.logic";
import {
  composeSuggestionNarrative,
  suggestionEvidenceLabels,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-suggestion-copy.logic";

type TimeSuggestionsLaneProps = {
  activeMinutes: number;
  loggedMinutes: number;
  items: TimeEntrySuggestion[];
  /** Suggestions whose decision is in flight; each stays disabled until its own request settles. */
  busyFingerprints: ReadonlySet<string>;
  onAccept: (suggestion: TimeEntrySuggestion, narrative: string) => void;
  onEdit: (suggestion: TimeEntrySuggestion, narrative: string) => void;
  onDismiss: (suggestion: TimeEntrySuggestion) => void;
};

const EVIDENCE_SEPARATOR = " · ";

export const TimeSuggestionsLane = ({
  activeMinutes,
  loggedMinutes,
  items,
  busyFingerprints,
  onAccept,
  onEdit,
  onDismiss,
}: TimeSuggestionsLaneProps) => {
  const t = useTranslations("billing.suggestions");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const copyLabels = {
    chatEvidence: (count: number, title: string) =>
      t("chatEvidence", { count, title }),
    unnamedRecord: t("unnamedRecord"),
  };

  return (
    <section
      aria-labelledby="time-suggestions-title"
      className="flex flex-col gap-2 rounded-lg border border-dashed p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium" id="time-suggestions-title">
          {t("title")}
        </h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("activeVsLogged", {
            active: formatMinutes(activeMinutes),
            logged: formatMinutes(loggedMinutes),
          })}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">{t("privacyNote")}</p>
      <ul className="flex flex-col gap-2">
        {items.map((suggestion) => {
          const narrative = composeSuggestionNarrative(
            suggestion.evidence,
            copyLabels,
          );
          const evidence = suggestionEvidenceLabels(
            suggestion.evidence,
            copyLabels,
          ).join(EVIDENCE_SEPARATOR);
          const busy = busyFingerprints.has(suggestion.fingerprint);
          return (
            <li
              className="flex min-h-14 items-center gap-3 rounded-lg border px-3 py-2"
              key={suggestion.fingerprint}
            >
              {/* The row body is the accept action; Edit and Dismiss keep their own buttons but also answer as shortcuts while the body has focus. */}
              <button
                aria-keyshortcuts="Enter E Delete"
                aria-label={timeEntryActionLabel(tCommon("accept"), narrative)}
                className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-md text-start outline-none focus-visible:ring-2 disabled:opacity-50"
                disabled={busy}
                onClick={() => onAccept(suggestion, narrative)}
                onKeyDown={(event) => {
                  if (event.key === "e" || event.key === "E") {
                    event.preventDefault();
                    onEdit(suggestion, narrative);
                  } else if (
                    event.key === "Delete" ||
                    event.key === "Backspace"
                  ) {
                    event.preventDefault();
                    onDismiss(suggestion);
                  }
                }}
                title={t("keyboardHint")}
                type="button"
              >
                <CheckIcon className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <BidiText
                    as="span"
                    className="block truncate text-sm font-medium"
                  >
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
                </span>
              </button>
              <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
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
        })}
      </ul>
    </section>
  );
};
