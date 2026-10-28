import { useTranslations } from "use-intl";

import type { TimeEntrySuggestion } from "@stll/api-contract/time-entry-types";

import {
  TimeSuggestionRow,
  type TimeSuggestionRowActions,
} from "@/components/billing/time-suggestion-row";
import { formatMinutes } from "@/lib/workspaces/format-duration";

type TimeSuggestionsLaneProps = TimeSuggestionRowActions & {
  activeMinutes: number;
  loggedMinutes: number;
  items: TimeEntrySuggestion[];
  /** Suggestions whose decision is in flight; each stays disabled until its own request settles. */
  busyFingerprints: ReadonlySet<string>;
};

export const TimeSuggestionsLane = ({
  activeMinutes,
  loggedMinutes,
  items,
  busyFingerprints,
  ...actions
}: TimeSuggestionsLaneProps) => {
  const t = useTranslations("billing.suggestions");

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
        {items.map((suggestion) => (
          <TimeSuggestionRow
            busy={busyFingerprints.has(suggestion.fingerprint)}
            key={suggestion.fingerprint}
            suggestion={suggestion}
            {...actions}
          />
        ))}
      </ul>
    </section>
  );
};
