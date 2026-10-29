import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { PencilIcon } from "@stll/ui/icons";

import { plainDateEpoch } from "@/components/billing/format-plain-date";
import { timeEntryActionLabel } from "@/components/billing/time-entry-copy.logic";
import {
  TimeSuggestionRow,
  type TimeSuggestionRowActions,
} from "@/components/billing/time-suggestion-row";
import { useFormatter } from "@/i18n/formatting-context";
import { formatMinutes } from "@/lib/workspaces/format-duration";
import type { MyTimeEntriesPage } from "@/lib/workspaces/queries/my-time-entries";
import type { MyTimeSuggestionRange } from "@/lib/workspaces/queries/my-time-suggestions";

export type MyTimeEntry = MyTimeEntriesPage["items"][number];
export type MySuggestionMatter =
  MyTimeSuggestionRange["days"][number]["matters"][number];
export type MySuggestion = MySuggestionMatter["items"][number];

type SuggestionActions = {
  [Action in keyof TimeSuggestionRowActions]: (
    matter: MySuggestionMatter["matter"],
    ...args: Parameters<TimeSuggestionRowActions[Action]>
  ) => void;
};

type MyWeekDayProps = SuggestionActions & {
  date: string;
  loggedMinutes: number;
  entries: MyTimeEntry[];
  /** False while some of the day's entries sit on week pages not yet loaded. */
  entriesComplete: boolean;
  suggestions: MySuggestionMatter[];
  busyFingerprints: ReadonlySet<string>;
  canDecide: boolean;
  canEdit: boolean;
  /** Per-entry notes from the last submission, by entry id. */
  notes: ReadonlyMap<string, string>;
  onEditEntry: (entry: MyTimeEntry) => void;
};

const LONG_DAY = {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;

const isEditableDraft = (entry: MyTimeEntry) =>
  entry.activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT &&
  entry.status === "draft" &&
  entry.timerStartedAt === null;

const DaySuggestions = ({
  suggestions,
  busyFingerprints,
  onAccept,
  onEdit,
  onDismiss,
}: SuggestionActions &
  Pick<MyWeekDayProps, "suggestions" | "busyFingerprints">) => {
  const t = useTranslations("billing.suggestions");
  return (
    <section
      aria-labelledby="my-week-suggestions-title"
      className="flex flex-col gap-2 rounded-lg border border-dashed p-3"
    >
      <h2 className="text-sm font-medium" id="my-week-suggestions-title">
        {t("title")}
      </h2>
      <p className="text-muted-foreground text-xs">{t("privacyNote")}</p>
      <ul className="flex flex-col gap-2">
        {suggestions.flatMap(({ matter, items }) =>
          items.map((suggestion) => (
            <TimeSuggestionRow
              busy={busyFingerprints.has(suggestion.fingerprint)}
              key={suggestion.fingerprint}
              matterName={matter.name}
              onAccept={(...args) => onAccept(matter, ...args)}
              onDismiss={(...args) => onDismiss(matter, ...args)}
              onEdit={(...args) => onEdit(matter, ...args)}
              suggestion={suggestion}
            />
          )),
        )}
      </ul>
    </section>
  );
};

const EntryRow = ({
  entry,
  canEdit,
  note,
  onEditEntry,
}: {
  entry: MyTimeEntry;
  canEdit: boolean;
  /** Why the last submission left this draft behind. */
  note: string | undefined;
  onEditEntry: (entry: MyTimeEntry) => void;
}) => {
  const t = useTranslations("timesheets.week");
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const tDay = useTranslations("timesheets.day");
  return (
    <li className="flex min-h-14 items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        {entry.activityGroup === TIME_ENTRY_ACTIVITY_GROUP.INTERNAL ? (
          <span className="text-muted-foreground block text-xs">
            {tDay("internalWork")}
          </span>
        ) : (
          <Link
            className="text-muted-foreground block truncate text-xs hover:underline"
            params={{ workspaceId: entry.workspaceId }}
            to="/workspaces/$workspaceId/timesheets"
          >
            <BidiText as="span">{entry.workspaceName}</BidiText>
          </Link>
        )}
        <BidiText as="p" className="truncate text-sm font-medium">
          {entry.narrative}
        </BidiText>
        <span className="text-muted-foreground text-xs">
          {[
            tBilling(`statuses.${entry.status}`),
            tBilling(entry.billable ? "billable" : "nonBillable"),
          ].join(" · ")}
        </span>
        {entry.status === "draft" && entry.returnComment !== null && (
          <BidiText as="p" className="text-sm">
            {t("returned", { comment: entry.returnComment })}
          </BidiText>
        )}
        {note !== undefined && (
          <p className="text-destructive text-sm" role="alert">
            {note}
          </p>
        )}
      </div>
      <span className="shrink-0 text-sm tabular-nums">
        {entry.timerStartedAt === null
          ? formatMinutes(entry.durationMinutes)
          : tCommon("running")}
      </span>
      {canEdit && isEditableDraft(entry) && (
        <Button
          aria-label={timeEntryActionLabel(tCommon("edit"), entry.narrative)}
          className="size-11"
          onClick={() => onEditEntry(entry)}
          size="icon"
          variant="ghost"
        >
          <PencilIcon className="size-4" />
        </Button>
      )}
    </li>
  );
};

/** The opened day: what is waiting to be logged, then what already is. */
export const MyWeekDay = ({
  date,
  loggedMinutes,
  entries,
  entriesComplete,
  suggestions,
  busyFingerprints,
  canDecide,
  canEdit,
  notes,
  onEditEntry,
  ...actions
}: MyWeekDayProps) => {
  const t = useTranslations("timesheets.week");
  const format = useFormatter();
  const pending = canDecide && suggestions.length > 0;

  return (
    <section
      aria-labelledby="my-week-day-title"
      className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium" id="my-week-day-title">
          {format.dateTime(plainDateEpoch(date), LONG_DAY)}
        </h2>
        <span className="text-sm font-medium tabular-nums">
          {formatMinutes(loggedMinutes)}
        </span>
      </div>
      {pending && (
        <DaySuggestions
          busyFingerprints={busyFingerprints}
          suggestions={suggestions}
          {...actions}
        />
      )}
      {entries.length > 0 && (
        <ul
          aria-label={t("entriesTitle")}
          className="divide-y rounded-lg border"
        >
          {entries.map((entry) => (
            <EntryRow
              canEdit={canEdit}
              entry={entry}
              note={notes.get(entry.id)}
              key={entry.id}
              onEditEntry={onEditEntry}
            />
          ))}
        </ul>
      )}
      {!pending && entriesComplete && (
        <p className="text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm">
          {entries.length === 0 ? t("noActivity") : t("allLogged")}
        </p>
      )}
    </section>
  );
};
