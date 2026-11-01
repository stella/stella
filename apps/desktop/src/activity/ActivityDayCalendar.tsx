import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic } from "better-result";
import { useFormatter, useLocale, useTranslations } from "use-intl";

import { DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH } from "@stll/api-contract/desktop-time-entries";
import type {
  DesktopMatter,
  DesktopTimeEntryBatch,
  DesktopTimeEntryBatchResponse,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DayCalendar } from "@stll/ui/day-calendar";
import type {
  DayCalendarBlock,
  DayCalendarColumn,
  DayCalendarTone,
} from "@stll/ui/day-calendar";
import { DAY_CALENDAR_GRANULARITIES } from "@stll/ui/day-calendar.logic";
import type {
  DayCalendarGranularity,
  DayCalendarRange,
} from "@stll/ui/day-calendar.logic";
import { PhoneIcon } from "@stll/ui/icons";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import {
  activityBlocks,
  blockDetails,
  calendarHours,
  draftedBlocks,
  manualSuggestion,
  matchedSuggestions,
  NARRATIVE_DECLINES_BEFORE_FOLD,
  narrativeTitles,
  nextSuggestion,
  segmentTitles,
} from "./activity-calendar-logic";
import type { ActivitySuggestion } from "./activity-calendar-logic";
import { calendarDate, timedSegments } from "./activity-logic";
import type {
  ActivityDaySnapshot,
  ActivityNarrativeAssist,
} from "./activity-types";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import { ActivitySuggestionCard } from "./ActivitySuggestionCard";
import type {
  AssistChoice,
  NarrativeAssistView,
  SuggestionEdit,
} from "./ActivitySuggestionCard";
import { EVIDENCE_DETAIL_LIMIT, matchDay } from "./day-review-logic";
import type { MatchedSegment } from "./day-review-logic";
import { useDurationLabel } from "./use-duration-label";

const ACTIVITY_COLUMN_ID = "activity";
const ENTRIES_COLUMN_ID = "entries";

type CandidateState =
  | { type: "loading" }
  | { type: "failed" }
  | { type: "ready"; matters: DesktopTimeEntryMatterCandidate[] };
type BatchItem = {
  entry: DesktopTimeEntryBatch["entries"][number];
  ranges: { start: string; end: string }[];
};
type PendingBatch = { idempotencyKey: string; items: BatchItem[] };
type Submission =
  | { type: "editing" }
  | ({ type: "submitting" } & PendingBatch)
  | ({ type: "retry" } & PendingBatch)
  | { type: "saved"; count: number };
export type ActivityReviewStatus = Submission["type"];
type DraftedEntries = ActivityDaySnapshot["draftedEntries"];

/** Which suggestion's card is open: a matched group, or a range the user
 * selected in the Activity column. */
type OpenCard =
  | { type: "closed" }
  | { id: string; type: "suggestion" }
  | { range: DayCalendarRange; type: "range" };

/** The stella AI description of one suggestion. */
type NarrativeStatus =
  | { type: "template" }
  | { type: "declined" }
  | { request: string; type: "writing" }
  | { type: "written" }
  | { type: "failed" };

type NarrativeApproval = Exclude<AssistChoice, "no">;

/** View preferences that outlive one day: the grid, and how often the user
 * declined a stella AI description in a row. */
export type ActivityCalendarPreferences = {
  granularity: DayCalendarGranularity;
  narrativeDeclines: number;
};

/** An Activity block's hover: its range, then each app with its time and the
 * title it spent longest on. */
const ActivityBlockDetails = ({
  details,
  range,
  sourceAppVisuals,
}: {
  details: ReturnType<typeof blockDetails>;
  range: string;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
}) => {
  const t = useTranslations("activity");
  const durationLabel = useDurationLabel();
  return (
    <div className="flex w-64 flex-col gap-2 py-0.5 text-xs">
      <p className="text-muted-foreground tabular-nums">{range}</p>
      <ul className="flex flex-col gap-1.5">
        {details.rows.map((row) => (
          <li className="flex items-start gap-2" key={row.identifier}>
            <ActivitySourceIcon
              appIdentifier={row.identifier}
              sourceAppVisuals={sourceAppVisuals}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-baseline justify-between gap-3">
                <bdi className="truncate font-medium">{row.name}</bdi>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {durationLabel(row.durationMs)}
                </span>
              </div>
              {row.title === null ? null : (
                <bdi className="text-muted-foreground truncate">
                  {row.title}
                </bdi>
              )}
            </div>
          </li>
        ))}
      </ul>
      {details.hiddenCount > 0 ? (
        <p className="text-muted-foreground">
          {t("moreApps", { count: details.hiddenCount })}
        </p>
      ) : null}
    </div>
  );
};

type DayMetricsProps = {
  segments: readonly MatchedSegment[];
  granularity: DayCalendarGranularity;
  onGranularityChange: (granularity: DayCalendarGranularity) => void;
};

const DayMetrics = ({
  segments,
  granularity,
  onGranularityChange,
}: DayMetricsProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const hours = (ms: number) =>
    t("hours", {
      hours: format.number(ms / 3_600_000, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    });
  const activeMs = segments.reduce(
    (sum, segment) => sum + segment.endMs - segment.startMs,
    0,
  );
  const draftedMs = segments.reduce(
    (sum, segment) =>
      sum + (segment.drafted ? segment.endMs - segment.startMs : 0),
    0,
  );
  const granularityLabel = (value: DayCalendarGranularity) =>
    value === 60
      ? t("hours", { hours: format.number(1) })
      : t("durationMinutes", { minutes: value });
  return (
    <div className="ms-auto flex flex-wrap items-center gap-6 tabular-nums">
      {[
        { label: t("activeLabel"), ms: activeMs },
        { label: t("draftedLabel"), ms: draftedMs },
      ].map(({ label, ms }) => (
        <div key={label}>
          <b className="block text-base font-semibold">{hours(ms)}</b>
          <span className="text-muted-foreground text-xs">{label}</span>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span
          className="text-muted-foreground text-xs"
          id="activity-granularity-label"
        >
          {t("granularity")}
        </span>
        <Select
          onValueChange={(value) => {
            const next = DAY_CALENDAR_GRANULARITIES.find(
              (candidate) => candidate === value,
            );
            if (next !== undefined) {
              onGranularityChange(next);
            }
          }}
          value={granularity}
        >
          <SelectTrigger
            aria-labelledby="activity-granularity-label"
            className="w-24"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {DAY_CALENDAR_GRANULARITIES.map((value) => (
              <SelectItem key={value} value={value}>
                {granularityLabel(value)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
};

type SubmissionFeedbackProps = {
  submission: Submission;
  errorMessage: string | null;
  onRetry: () => void;
};

const SubmissionFeedback = ({
  submission,
  errorMessage,
  onRetry,
}: SubmissionFeedbackProps) => {
  const t = useTranslations("activity");
  return (
    <>
      {errorMessage ? (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage}
        </p>
      ) : null}
      {submission.type === "saved" ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t("batchCreated", { count: submission.count })}
        </p>
      ) : null}
      {submission.type === "retry" || submission.type === "submitting" ? (
        <div>
          <Button
            size="sm"
            disabled={submission.type === "submitting"}
            onClick={onRetry}
          >
            {t("pendingRetry")}
          </Button>
        </div>
      ) : null}
    </>
  );
};

type ActivityDayCalendarProps = {
  header: ReactNode;
  snapshot: ActivityDaySnapshot;
  preferences: ActivityCalendarPreferences;
  onPreferencesChange: (preferences: ActivityCalendarPreferences) => void;
  onCopy: (text: string, onSettled: (copied: boolean) => void) => void;
  onReviewStatusChange: (status: ActivityReviewStatus) => void;
};

export const ActivityDayCalendar = ({
  header,
  snapshot,
  preferences,
  onPreferencesChange,
  onCopy,
  onReviewStatusChange,
}: ActivityDayCalendarProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const locale = useLocale();
  const { candidates, refreshCandidates } = useMatterCandidates();
  const [localDrafts, setLocalDrafts] = useState<DraftedEntries>([]);
  const { submission, submitBatch, errorMessage } = useBatchSubmission({
    date: snapshot.date,
    pendingBatch: snapshot.pendingBatch,
    onReviewStatusChange,
    onDrafted: (drafted) =>
      setLocalDrafts((current) => [...current, ...drafted]),
  });
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(new Set());
  const [openCard, setOpenCard] = useState<OpenCard>({ type: "closed" });

  const timeZone = Temporal.Now.timeZoneId();
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  const matters = candidates.type === "ready" ? candidates.matters : [];
  const draftedEntries = [...snapshot.draftedEntries, ...localDrafts];
  const day = matchDay({
    segments: timedSegments(snapshot.segments),
    candidates: matters,
    captureDetails: snapshot.captureDetails,
    manualAssignments: snapshot.manualAssignments,
    draftedEntries,
  });
  const suggestions = matchedSuggestions(day.groups, leftOut);
  const editable = submission.type === "editing" || submission.type === "saved";
  const narratives = useSuggestionNarratives({
    assistSetting: snapshot.narrativeAssist,
    preferences,
    onPreferencesChange,
  });

  const openSuggestion = (() => {
    switch (openCard.type) {
      case "closed":
        return null;
      case "suggestion":
        return suggestions.find(({ id }) => id === openCard.id) ?? null;
      case "range":
        return manualSuggestion(day.segments, openCard.range);
      default:
        openCard satisfies never;
        return panic("Unhandled activity card");
    }
  })();

  const open = (next: OpenCard, suggestion: ActivitySuggestion) => {
    setOpenCard(next);
    narratives.opened(suggestion);
  };
  const openNext = (after: ActivitySuggestion) => {
    const next = nextSuggestion(suggestions, {
      afterMs: after.startMs,
      excludeId: after.id,
    });
    if (next === null) {
      setOpenCard({ type: "closed" });
      return;
    }
    open({ id: next.id, type: "suggestion" }, next);
  };
  const accept = (suggestion: ActivitySuggestion) => {
    const edit = narratives.editFor(suggestion);
    if (
      !editable ||
      edit.matter === null ||
      edit.narrative.trim().length === 0 ||
      suggestion.roundedTenths === 0
    ) {
      return;
    }
    // One confirmed entry per batch: the batch path keeps the idempotency
    // key and the stored pending request for this single acceptance.
    submitBatch(
      {
        idempotencyKey: crypto.randomUUID(),
        items: [
          {
            entry: {
              matterId: edit.matter.id,
              dateWorked: snapshot.date,
              timezoneId: timeZone,
              durationMinutes: suggestion.roundedTenths * 6,
              narrative: edit.narrative,
              billable: edit.billable,
            },
            ranges: suggestion.ranges,
          },
        ],
      },
      () => openNext(suggestion),
    );
  };
  const reject = (suggestion: ActivitySuggestion) => {
    if (suggestion.type === "matched") {
      setLeftOut((current) => new Set([...current, suggestion.id]));
    }
    openNext(suggestion);
  };

  const formatRange = (startMs: number, endMs: number) =>
    format.dateTimeRange(startMs, endMs, {
      hour: "numeric",
      minute: "2-digit",
    });
  const hours = (tenths: number) =>
    format.number(tenths / 10, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  const columns = useCalendarColumns({
    segments: day.segments,
    granularity: preferences.granularity,
    sourceAppVisuals: snapshot.sourceAppVisuals,
    rangeSelection: editable,
    draftedEntries,
    suggestions,
    narrativeFor: (suggestion) => narratives.editFor(suggestion).narrative,
    onActivate: (suggestion) =>
      open({ id: suggestion.id, type: "suggestion" }, suggestion),
  });

  const card =
    openSuggestion === null ? null : (
      <ActivitySuggestionCard
        key={openSuggestion.id}
        suggestion={openSuggestion}
        edit={narratives.editFor(openSuggestion)}
        candidates={matters}
        editable={editable}
        timeLabel={t("rangeHours", {
          range: formatRange(openSuggestion.startMs, openSuggestion.endMs),
          hours: hours(openSuggestion.roundedTenths),
        })}
        sourceAppVisuals={snapshot.sourceAppVisuals}
        assist={narratives.view(openSuggestion)}
        onAssist={(choice) => narratives.choose(openSuggestion, choice)}
        onEdit={(change) => narratives.update(openSuggestion, change)}
        onAccept={() => accept(openSuggestion)}
        onReject={() => reject(openSuggestion)}
        onClose={() => setOpenCard({ type: "closed" })}
        onCopy={async () =>
          // Resolves once the copy settles; a failed copy is reported by the
          // command runner and resolves false.
          new Promise<boolean>((resolve) => {
            const edit = narratives.editFor(openSuggestion);
            onCopy(
              `${edit.matter?.name ?? t("newEntry")} · ${format.dateTime(calendarDate(snapshot.date), { dateStyle: "medium" })} · ${t("hours", { hours: hours(openSuggestion.roundedTenths) })}: ${edit.narrative}`,
              resolve,
            );
          })
        }
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-5">
        {header}
        <DayMetrics
          segments={day.segments}
          granularity={preferences.granularity}
          onGranularityChange={(granularity) =>
            onPreferencesChange({ ...preferences, granularity })
          }
        />
      </div>
      {candidates.type === "failed" ? (
        <div
          role="alert"
          className="text-destructive flex items-center gap-2 text-sm"
        >
          {t("candidatesFailed")}
          <Button size="sm" variant="ghost" onClick={refreshCandidates}>
            {t("retry")}
          </Button>
        </div>
      ) : null}
      <SubmissionFeedback
        submission={submission}
        errorMessage={errorMessage}
        onRetry={() => {
          if (submission.type === "retry") {
            submitBatch(submission, () => undefined);
          }
        }}
      />
      <DayCalendar
        ariaLabel={t("calendarLabel", {
          date: format.dateTime(calendarDate(snapshot.date), {
            dateStyle: "full",
          }),
        })}
        columns={columns}
        date={snapshot.date}
        granularity={preferences.granularity}
        hours={calendarHours({
          date: snapshot.date,
          timeZone,
          // Now stretches only today's grid; on another day it would add
          // empty hours up to the day's edge.
          instants: [
            ...day.segments.flatMap(({ startMs, endMs }) => [startMs, endMs]),
            ...(snapshot.date === snapshot.today ? [nowMs] : []),
          ],
        })}
        locale={locale}
        nowMs={nowMs}
        onSelectRange={(columnId, range) => {
          if (columnId === ENTRIES_COLUMN_ID) {
            open(
              { range, type: "range" },
              manualSuggestion(day.segments, range),
            );
          }
        }}
        selection={
          openSuggestion === null
            ? null
            : {
                columnId: ENTRIES_COLUMN_ID,
                panel: { columnId: ENTRIES_COLUMN_ID, content: card },
                range: {
                  endMs: openSuggestion.endMs,
                  startMs: openSuggestion.startMs,
                },
              }
        }
        timeZone={timeZone}
      />
      <p className="text-muted-foreground text-xs">{t("calendarHint")}</p>
    </div>
  );
};

type CalendarColumnsOptions = {
  segments: readonly MatchedSegment[];
  granularity: DayCalendarGranularity;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
  rangeSelection: boolean;
  draftedEntries: DraftedEntries;
  suggestions: readonly ActivitySuggestion[];
  narrativeFor: (suggestion: ActivitySuggestion) => string;
  onActivate: (suggestion: ActivitySuggestion) => void;
};

/** The Activity column (recorded time) and the Time entries column (created
 * drafts and suggestions). */
function useCalendarColumns({
  segments,
  granularity,
  sourceAppVisuals,
  rangeSelection,
  draftedEntries,
  suggestions,
  narrativeFor,
  onActivate,
}: CalendarColumnsOptions): DayCalendarColumn[] {
  const t = useTranslations("activity");
  const format = useFormatter();
  const formatRange = (startMs: number, endMs: number) =>
    format.dateTimeRange(startMs, endMs, {
      hour: "numeric",
      minute: "2-digit",
    });
  const hours = (tenths: number) =>
    format.number(tenths / 10, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  const hoursUnit = (tenths: number) =>
    format.number(tenths / 10, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
      style: "unit",
      unit: "hour",
      unitDisplay: "narrow",
    });
  const durationLabel = useDurationLabel();
  const titleOf = segmentTitles(segments);

  const activity = activityBlocks(segments, granularity).map(
    (block): DayCalendarBlock => {
      const range = formatRange(block.startMs, block.endMs);
      const tooltip = (
        <ActivityBlockDetails
          details={blockDetails(block.sources, titleOf)}
          range={range}
          sourceAppVisuals={sourceAppVisuals}
        />
      );
      const apps = format.list(
        block.apps.map(({ name }) => name),
        { type: "unit" },
      );
      const duration = durationLabel(
        block.sources.reduce(
          (sum, segment) => sum + segment.endMs - segment.startMs,
          0,
        ),
      );
      const onlyApp = block.apps.length === 1 ? block.sources.at(0) : undefined;
      const onCall =
        onlyApp !== undefined && block.sources.every(({ call }) => call);
      // A block on one app names the app and shows its icon; one that moved
      // between apps lists them under its topic.
      let appName: string | null = null;
      let appIcon: ReactNode = null;
      if (onlyApp !== undefined && onCall) {
        appName = t("callIn", { app: onlyApp.appName });
        appIcon = (
          <PhoneIcon aria-hidden="true" className="size-3.5 shrink-0" />
        );
      } else if (onlyApp !== undefined) {
        appName = onlyApp.appName;
        appIcon = (
          <ActivitySourceIcon
            appIdentifier={onlyApp.appIdentifier}
            sourceAppVisuals={sourceAppVisuals}
          />
        );
      }
      const topic =
        block.matter?.name ?? appName ?? block.title ?? t("mixedActivity");
      const detail =
        block.matter === null && appName === null ? null : block.title;
      const label = [topic, duration, detail]
        .filter((part) => part !== null)
        .join(" · ");
      const switching = block.matter === null && onlyApp === undefined;
      return {
        accessibleLabel: switching
          ? t("mixedActivityLabel", { apps, range })
          : `${[topic, detail, onlyApp === undefined ? apps : null]
              .filter((part) => part !== null)
              .join(" · ")}, ${range}`,
        caption: onlyApp === undefined ? apps : range,
        endMs: block.endMs,
        id: block.id,
        kind: switching ? "mixed" : "segment",
        startMs: block.startMs,
        title: (
          <span className="flex min-w-0 items-center gap-1.5">
            {appIcon}
            <bdi className="truncate">{label}</bdi>
          </span>
        ),
        tone: matterTone(block.matter),
        tooltip,
      };
    },
  );

  const entries: DayCalendarBlock[] = draftedBlocks(
    draftedEntries,
    segments,
  ).map((block) => {
    const name = block.matter?.name ?? t("draftedEntry");
    const caption = t("draftedRange", {
      range: formatRange(block.startMs, block.endMs),
    });
    return {
      accessibleLabel: `${name}, ${caption}`,
      caption,
      endMs: block.endMs,
      id: `drafted:${block.entryId}:${String(block.startMs)}`,
      kind: "entry",
      startMs: block.startMs,
      state: "final",
      title: <bdi>{name}</bdi>,
      tone: matterTone(block.matter),
    };
  });
  for (const suggestion of suggestions) {
    const name = suggestion.matter?.name ?? t("newEntry");
    const roundedHours = hours(suggestion.roundedTenths);
    const accessibleLabel = t("suggestionLabel", {
      matter: name,
      hours: roundedHours,
    });
    // The description reads first, as on a timesheet; the range stands in
    // while there is none.
    const narrative = narrativeFor(suggestion).trim();
    for (const run of suggestion.runs) {
      entries.push({
        accessibleLabel,
        caption:
          narrative.length > 0 ? (
            <bdi>{narrative}</bdi>
          ) : (
            t("rangeHours", {
              range: formatRange(run.startMs, run.endMs),
              hours: roundedHours,
            })
          ),
        endMs: run.endMs,
        id: `${suggestion.id}:${String(run.startMs)}`,
        kind: "entry",
        onActivate: () => onActivate(suggestion),
        startMs: run.startMs,
        state: "suggestion",
        title: (
          <bdi>
            {name} · {hoursUnit(suggestion.roundedTenths)}
          </bdi>
        ),
        tone: matterTone(suggestion.matter),
      });
    }
  }

  return [
    {
      blocks: activity,
      id: ACTIVITY_COLUMN_ID,
      label: t("title"),
      // Activity is the record; entries are drawn where they are kept.
      rangeSelection: { type: "disabled" },
      type: "blocks",
    },
    {
      blocks: entries,
      id: ENTRIES_COLUMN_ID,
      label: t("timeEntries"),
      rangeSelection: rangeSelection
        ? { label: t("selectRange"), type: "enabled" }
        : { type: "disabled" },
      type: "blocks",
    },
  ];
}

function matterTone(
  matter: Pick<DesktopMatter, "color" | "id"> | null,
): DayCalendarTone {
  return matter === null
    ? { type: "neutral" }
    : { color: matter.color, matterId: matter.id, type: "matter" };
}

type SuggestionNarrativesOptions = {
  assistSetting: ActivityNarrativeAssist;
  preferences: ActivityCalendarPreferences;
  onPreferencesChange: (preferences: ActivityCalendarPreferences) => void;
};

/**
 * Each suggestion's editable fields and its stella AI description. Titles
 * leave the window only after the user approves, once or always; without
 * approval the narrative stays the local template.
 */
function useSuggestionNarratives({
  assistSetting,
  preferences,
  onPreferencesChange,
}: SuggestionNarrativesOptions) {
  const t = useTranslations("activity");
  const format = useFormatter();
  const locale = useLocale();
  const [edits, setEdits] = useState<Record<string, SuggestionEdit>>({});
  const [statuses, setStatuses] = useState<Record<string, NarrativeStatus>>({});
  // The change event that carries a persisted "always" can arrive after the
  // next card opens, so the choice applies at once; it lasts only until its
  // request settles, after which the saved setting decides again, so a failed
  // save or a later "ask" in Settings never leaves a standing approval.
  const [alwaysApproved, setAlwaysApproved] = useState(false);
  const assist = alwaysApproved ? "always" : assistSetting;

  // The template never exceeds what a time entry accepts.
  const template = (suggestion: ActivitySuggestion) => {
    const titles = suggestion.evidence.flatMap(({ details }) =>
      details.slice(0, EVIDENCE_DETAIL_LIMIT).map(({ title }) => title),
    );
    const text =
      titles.length > 0
        ? t("narrativeEvidence", {
            evidence: format.list([...new Set(titles)], {
              type: "conjunction",
            }),
          })
        : t("narrativeApps", {
            apps: format.list(
              suggestion.apps.map(({ name }) => name),
              { type: "conjunction" },
            ),
          });
    return text.slice(0, DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH);
  };
  const editFor = (suggestion: ActivitySuggestion): SuggestionEdit =>
    edits[suggestion.id] ?? {
      billable: true,
      matter: suggestion.matter,
      narrative: template(suggestion),
      written: 0,
    };
  const statusFor = (suggestion: ActivitySuggestion): NarrativeStatus =>
    statuses[suggestion.id] ?? { type: "template" };
  const setStatus = (id: string, status: NarrativeStatus) =>
    setStatuses((current) => ({ ...current, [id]: status }));
  /** Applies `status` only while `request` is still the latest request. */
  const settle = (id: string, request: string, status: NarrativeStatus) =>
    setStatuses((current) => {
      const latest = current[id];
      return latest?.type === "writing" && latest.request === request
        ? { ...current, [id]: status }
        : current;
    });

  const generate = (
    suggestion: ActivitySuggestion,
    approval: NarrativeApproval,
  ) => {
    const titles = narrativeTitles(suggestion);
    if (titles.length === 0) {
      return;
    }
    const request = crypto.randomUUID();
    const { matter, narrative: before } = editFor(suggestion);
    setStatus(suggestion.id, { request, type: "writing" });
    // Only this suggestion's titles, the reader's language and the chosen
    // matter's name leave the window, and only after the user approved.
    invoke<string>("activity_generate_narrative", {
      request: { titles, locale, matterName: matter?.name ?? null, approval },
    })
      .finally(() => {
        if (approval === "always") {
          setAlwaysApproved(false);
        }
      })
      .then((narrative) => {
        settle(suggestion.id, request, { type: "written" });
        setEdits((current) => {
          const edit = current[suggestion.id] ?? editFor(suggestion);
          // Text the user typed meanwhile wins over the description.
          if (edit.narrative !== before) {
            return current;
          }
          return {
            ...current,
            [suggestion.id]: {
              ...edit,
              narrative,
              written: edit.written + 1,
            },
          };
        });
        return undefined;
      })
      .catch(() => settle(suggestion.id, request, { type: "failed" }));
  };

  return {
    editFor,
    update: (suggestion: ActivitySuggestion, change: Partial<SuggestionEdit>) =>
      setEdits((current) => ({
        ...current,
        [suggestion.id]: {
          ...(current[suggestion.id] ?? editFor(suggestion)),
          ...change,
        },
      })),
    /** With standing approval, a card writes its description as it opens. */
    opened: (suggestion: ActivitySuggestion) => {
      if (assist === "always" && statusFor(suggestion).type === "template") {
        generate(suggestion, "once");
      }
    },
    choose: (suggestion: ActivitySuggestion, choice: AssistChoice) => {
      switch (choice) {
        case "no":
          setStatus(suggestion.id, { type: "declined" });
          onPreferencesChange({
            ...preferences,
            narrativeDeclines: preferences.narrativeDeclines + 1,
          });
          return;
        case "always":
          setAlwaysApproved(true);
          onPreferencesChange({ ...preferences, narrativeDeclines: 0 });
          generate(suggestion, "always");
          return;
        case "once":
          onPreferencesChange({ ...preferences, narrativeDeclines: 0 });
          generate(suggestion, "once");
          return;
        default:
          choice satisfies never;
          panic("Unhandled stella AI choice");
      }
    },
    view: (suggestion: ActivitySuggestion): NarrativeAssistView => {
      if (narrativeTitles(suggestion).length === 0) {
        return { type: "hidden" };
      }
      const status = statusFor(suggestion);
      switch (status.type) {
        case "writing":
          return { type: "writing" };
        case "written":
          return { type: "hidden" };
        case "failed":
          return { type: "failed" };
        case "declined":
          return { type: "folded" };
        case "template":
          if (
            assist === "always" ||
            preferences.narrativeDeclines >= NARRATIVE_DECLINES_BEFORE_FOLD
          ) {
            return { type: "folded" };
          }
          return { type: "ask" };
        default:
          status satisfies never;
          return panic("Unhandled stella AI description status");
      }
    },
  };
}

type BatchSubmissionOptions = {
  date: string;
  pendingBatch: ActivityDaySnapshot["pendingBatch"];
  onReviewStatusChange: (status: ActivityReviewStatus) => void;
  onDrafted: (drafted: DraftedEntries) => void;
};

/** The confirmed-batch path: a stored pending batch is retried with its own
 * key; a new acceptance gets a new key. */
function useBatchSubmission({
  date,
  pendingBatch,
  onReviewStatusChange,
  onDrafted,
}: BatchSubmissionOptions) {
  const t = useTranslations("activity");
  const { submission, updateSubmission } = useReviewSubmission({
    pendingBatch,
    onReviewStatusChange,
  });
  const [errorMessage, setError] = useState<string | null>(null);
  const sending = useRef(false);

  const submitBatch = (pending: PendingBatch, onSaved: () => void) => {
    if (sending.current) {
      return;
    }
    sending.current = true;
    setError(null);
    updateSubmission({
      type: "submitting",
      idempotencyKey: pending.idempotencyKey,
      items: pending.items,
    });
    invoke<DesktopTimeEntryBatchResponse & { markerSaved: boolean }>(
      "time_entry_submit_batch_confirmed",
      {
        request: {
          date,
          idempotencyKey: pending.idempotencyKey,
          items: pending.items,
        },
      },
    )
      .then(({ entries, markerSaved }) => {
        onDrafted(
          pending.items.flatMap((item, index) => {
            const entry = entries.at(index);
            return entry
              ? item.ranges.map((range) => ({ ...range, entryId: entry.id }))
              : [];
          }),
        );
        if (!markerSaved) {
          updateSubmission({
            type: "retry",
            idempotencyKey: pending.idempotencyKey,
            items: pending.items,
          });
          setError(t("draftMarkerFailed"));
          return undefined;
        }
        updateSubmission({ type: "saved", count: entries.length });
        onSaved();
        return undefined;
      })
      .catch((error: unknown) => {
        const rejected =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "rejected";
        if (rejected && pendingBatch === null) {
          updateSubmission({ type: "editing" });
        } else {
          updateSubmission({
            type: "retry",
            idempotencyKey: pending.idempotencyKey,
            items: pending.items,
          });
        }
        setError(t("batchFailed"));
      })
      .finally(() => {
        sending.current = false;
      });
  };
  return { submission, submitBatch, errorMessage };
}

function useMatterCandidates() {
  const [candidates, setCandidates] = useState<CandidateState>({
    type: "loading",
  });
  const candidateRequest = useRef(0);
  const refreshCandidates = useCallback(() => {
    const request = ++candidateRequest.current;
    invoke<DesktopTimeEntryMatterCandidate[]>("time_entry_candidates")
      .then((matters) => {
        if (request === candidateRequest.current) {
          setCandidates({ type: "ready", matters });
        }
        return undefined;
      })
      .catch(() => {
        if (request === candidateRequest.current) {
          setCandidates({ type: "failed" });
        }
      });
  }, []);
  useEffect(() => {
    refreshCandidates();
    return () => {
      candidateRequest.current += 1;
    };
  }, [refreshCandidates]);
  return { candidates, refreshCandidates };
}

type ReviewSubmissionOptions = {
  pendingBatch: ActivityDaySnapshot["pendingBatch"];
  onReviewStatusChange: (status: ActivityReviewStatus) => void;
};

function useReviewSubmission({
  pendingBatch,
  onReviewStatusChange,
}: ReviewSubmissionOptions) {
  const durablePendingKey = useRef(pendingBatch?.idempotencyKey ?? null);
  const [submission, setSubmission] = useState<Submission>(() => {
    if (!pendingBatch) {
      return { type: "editing" };
    }
    return {
      type: "retry",
      idempotencyKey: pendingBatch.idempotencyKey,
      items: pendingBatch.entries.map((entry, index) => ({
        entry,
        ranges: pendingBatch.ranges.at(index) ?? [],
      })),
    };
  });
  const updateSubmission = (next: Submission) => {
    setSubmission(next);
    onReviewStatusChange(next.type);
  };
  useEffect(() => {
    if (pendingBatch !== null) {
      durablePendingKey.current = pendingBatch.idempotencyKey;
    }
    if (
      pendingBatch === null &&
      submission.type === "retry" &&
      durablePendingKey.current === submission.idempotencyKey
    ) {
      durablePendingKey.current = null;
      setSubmission({ type: "editing" });
      onReviewStatusChange("editing");
      return;
    }
    if (
      pendingBatch === null &&
      (submission.type === "editing" || submission.type === "saved")
    ) {
      durablePendingKey.current = null;
    }
    onReviewStatusChange(submission.type);
  }, [onReviewStatusChange, pendingBatch, submission]);
  return { submission, updateSubmission };
}
