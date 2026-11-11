import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

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
import { Separator } from "@stll/ui/separator";

import {
  activityBlocks,
  blockDetails,
  calendarHours,
  draftedBlocks,
  manualSuggestion,
  matchedSuggestions,
  nextSuggestion,
  segmentTitles,
  suggestionPieces,
  suggestionSummary,
} from "./activity-calendar-logic";
import type {
  ActivityBlock,
  ActivitySuggestion,
  SuggestionSummary,
} from "./activity-calendar-logic";
import { calendarDate, timedSegments } from "./activity-logic";
import type {
  ActivityAppExclusion,
  ActivityDaySnapshot,
} from "./activity-types";
import {
  BrowserTitlesNotice,
  OpenAccessibilitySettingsButton,
} from "./ActivityCaptureDetails";
import type { CaptureDetailsCommand } from "./ActivityCaptureDetails";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import { ActivitySuggestionCard } from "./ActivitySuggestionCard";
import type {
  DraftAssistView,
  SuggestionEdit,
  SuggestionTimes,
} from "./ActivitySuggestionCard";
import {
  cardDraftEntry,
  cardDraftFrom,
  structureItems,
} from "./billing-draft-logic";
import type { CardDraft, DraftFailureKind } from "./billing-draft-logic";
import { useBillingDraftSettings } from "./billing-draft-settings";
import type {
  BillingDraftSettings,
  BillingDraftSettingsControl,
} from "./billing-draft-settings";
import type { CaptureModeCommand } from "./capture-modes";
import { EVIDENCE_DETAIL_LIMIT, matchDay } from "./day-review-logic";
import type { MatchedSegment } from "./day-review-logic";
import { SuggestionPieceLabel } from "./SuggestionPieceLabel";
import { explainedBrowsers, missingTitlesReason } from "./title-capture-logic";
import type { ExplainedBrowser } from "./title-capture-logic";
import { useDurationLabel, useMinutesLabel } from "./use-duration-label";

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
 * selected in the Time entries column. A range keeps the id it opened with
 * while the user moves it, so the card keeps what was typed into it. */
type OpenCard =
  | { type: "closed" }
  | { id: string; type: "suggestion" }
  | { id: string; range: DayCalendarRange; type: "range" };

type RangeCard = Extract<OpenCard, { type: "range" }>;

/** View preferences that outlive one day: the grid. */
export type ActivityCalendarPreferences = {
  granularity: DayCalendarGranularity;
};

/** An Activity block's hover: its range, then each app with its time and the
 * title it spent longest on, then why a browser in it recorded no titles. */
const ActivityBlockDetails = ({
  details,
  range,
  sourceAppVisuals,
  titlesNotice,
}: {
  details: ReturnType<typeof blockDetails>;
  range: string;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
  titlesNotice: ReactElement | null;
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
      {titlesNotice === null ? null : (
        <>
          <Separator />
          {titlesNotice}
        </>
      )}
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

/** Sends a capture-settings command, as the Settings window does. */
export type CaptureCommandRunner = (
  command: CaptureDetailsCommand | CaptureModeCommand["command"],
  args?: Record<string, unknown>,
  onSuccess?: () => void,
  onFailure?: () => void,
) => void;

type ActivityDayCalendarProps = {
  header: ReactNode;
  /** Shown under the header row: why titles are not recorded, or the
   * browser question; nothing when absent. */
  notice?: ReactNode;
  snapshot: ActivityDaySnapshot;
  preferences: ActivityCalendarPreferences;
  onPreferencesChange: (preferences: ActivityCalendarPreferences) => void;
  onCopy: (text: string, onSettled: (copied: boolean) => void) => void;
  onCaptureCommand: CaptureCommandRunner;
  onReviewStatusChange: (status: ActivityReviewStatus) => void;
};

export const ActivityDayCalendar = ({
  header,
  notice,
  snapshot,
  preferences,
  onPreferencesChange,
  onCopy,
  onCaptureCommand,
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
  const titlesNotices = useTitlesNotices(snapshot, onCaptureCommand);

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
  const drafting = useBillingDraftSettings(true);
  const narratives = useSuggestionDrafts({
    drafting,
    date: snapshot.date,
    timeZone,
    captureDetails: snapshot.captureDetails,
  });

  const rangeSuggestion = ({ id, range }: RangeCard) =>
    manualSuggestion({
      drafted: draftedEntries,
      id,
      range,
      segments: day.segments,
    });
  const openSuggestion = (() => {
    switch (openCard.type) {
      case "closed":
        return null;
      case "suggestion":
        return suggestions.find(({ id }) => id === openCard.id) ?? null;
      case "range":
        return rangeSuggestion(openCard);
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
              ...(edit.classification === null
                ? {}
                : { classification: edit.classification }),
            },
            ranges: suggestion.ranges,
          },
        ],
      },
      () => openNext(suggestion),
    );
  };
  /** An accepted split or move creates its entries in one confirmed batch,
   * each covering its own share of the recorded time. */
  const acceptStructure = (suggestion: ActivitySuggestion) => {
    const structure = narratives.structure(suggestion);
    const edit = narratives.editFor(suggestion);
    if (
      !editable ||
      structure === null ||
      edit.matter === null ||
      suggestion.roundedTenths === 0
    ) {
      return;
    }
    submitBatch(
      {
        idempotencyKey: crypto.randomUUID(),
        items: structureItems({
          structure,
          card: {
            matterId: edit.matter.id,
            narrative: edit.narrative,
            billable: edit.billable,
            classification: edit.classification,
          },
          durationMinutes: suggestion.roundedTenths * 6,
          ranges: suggestion.ranges,
          date: snapshot.date,
          timezoneId: timeZone,
        }),
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

  const hours = (tenths: number) =>
    format.number(tenths / 10, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  const summaryLabel = useSummaryLabel();
  // Matters group the day, so its blocks wait for them: drawn before they
  // arrive, every block a matter claims would be drawn again as another one,
  // under a pointer or focus already on it. The grid shows meanwhile.
  const matched = candidates.type !== "loading";
  const columns = useCalendarColumns({
    segments: matched ? day.segments : [],
    granularity: preferences.granularity,
    sourceAppVisuals: snapshot.sourceAppVisuals,
    rangeSelection: editable,
    draftedEntries: matched ? draftedEntries : [],
    suggestions: matched ? suggestions : [],
    narrativeFor: (suggestion) => narratives.editFor(suggestion).narrative,
    onActivate: (suggestion) =>
      open({ id: suggestion.id, type: "suggestion" }, suggestion),
    titlesNoticeFor: titlesNotices.forApps,
  });

  const card =
    openSuggestion === null ? null : (
      <ActivitySuggestionCard
        key={openSuggestion.id}
        suggestion={openSuggestion}
        times={cardTimes({
          date: snapshot.date,
          openCard,
          setOpenCard,
          timeZone,
        })}
        edit={narratives.editFor(openSuggestion)}
        candidates={matters}
        editable={editable}
        timeLabel={summaryLabel(suggestionSummary(openSuggestion))}
        sourceAppVisuals={snapshot.sourceAppVisuals}
        titlesNotice={titlesNotices.forSuggestion(openSuggestion)}
        assist={narratives.view(openSuggestion)}
        earlierEntries={narratives.earlierEntries(openSuggestion)}
        flags={narratives.flags(openSuggestion)}
        structure={narratives.structure(openSuggestion)}
        onAcceptStructure={() => acceptStructure(openSuggestion)}
        onDraft={() => narratives.draft(openSuggestion)}
        onAllow={() => narratives.allow(openSuggestion)}
        onRefine={(steer, remember) =>
          narratives.refine(openSuggestion, steer, remember)
        }
        onAcceptProposal={() => narratives.acceptProposal(openSuggestion)}
        onDismissProposal={() => narratives.dismissProposal(openSuggestion)}
        onUndo={() => narratives.undo(openSuggestion)}
        onRestoreTemplate={() => narratives.restoreTemplate(openSuggestion)}
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
      {notice}
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
            // A range set on its card stays in view wherever it is moved.
            ...rangeEdges(openCard),
          ],
        })}
        locale={locale}
        nowMs={nowMs}
        onSelectRange={(columnId, range) => {
          if (columnId === ENTRIES_COLUMN_ID) {
            const selected = rangeCard(range);
            open(selected, rangeSuggestion(selected));
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

/** What a suggestion card's header says about its time: its range or how
 * many pieces it has, the minutes they hold and the hours they bill. */
const useSummaryLabel = () => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const minutesLabel = useMinutesLabel();
  const hours = (tenths: number) =>
    format.number(tenths / 10, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  return (summary: SuggestionSummary) => {
    const duration = minutesLabel(summary.minutes);
    switch (summary.type) {
      case "range":
        return t("suggestionRange", {
          duration,
          hours: hours(summary.tenths),
          range: format.dateTimeRange(summary.startMs, summary.endMs, {
            hour: "numeric",
            minute: "2-digit",
          }),
        });
      case "pieces":
        return t("suggestionPieces", {
          count: summary.count,
          duration,
          hours: hours(summary.tenths),
        });
      default:
        summary satisfies never;
        return panic("Unhandled suggestion summary");
    }
  };
};

/** The card for a range selected on the grid, named by the range it opened
 * with. */
const rangeCard = (range: DayCalendarRange): RangeCard => ({
  id: `manual:${String(range.startMs)}:${String(range.endMs)}`,
  range,
  type: "range",
});

const rangeEdges = (openCard: OpenCard) =>
  openCard.type === "range"
    ? [openCard.range.startMs, openCard.range.endMs]
    : [];

/** A selected range is set on its card; a matched suggestion's time is what
 * was recorded. */
const cardTimes = ({
  date,
  openCard,
  setOpenCard,
  timeZone,
}: {
  date: string;
  openCard: OpenCard;
  setOpenCard: (card: OpenCard) => void;
  timeZone: string;
}): SuggestionTimes =>
  openCard.type === "range"
    ? {
        date,
        onRangeChange: (range) =>
          setOpenCard({ id: openCard.id, range, type: "range" }),
        range: openCard.range,
        timeZone,
        type: "selected",
      }
    : { type: "recorded" };

type CalendarColumnsOptions = {
  segments: readonly MatchedSegment[];
  granularity: DayCalendarGranularity;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
  rangeSelection: boolean;
  draftedEntries: DraftedEntries;
  suggestions: readonly ActivitySuggestion[];
  narrativeFor: (suggestion: ActivitySuggestion) => string;
  onActivate: (suggestion: ActivitySuggestion) => void;
  /** Why browsers among these apps recorded no titles, with the action that
   * records them; `null` when there is nothing to explain. */
  titlesNoticeFor: (identifiers: readonly string[]) => ReactElement | null;
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
  titlesNoticeFor,
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
  const durationLabel = useDurationLabel();
  const minutesLabel = useMinutesLabel();
  const titleOf = segmentTitles(segments);

  const activity = activityBlocks(segments, granularity).map(
    (block): DayCalendarBlock => {
      const range = formatRange(block.startMs, block.endMs);
      const titlesNotice = titlesNoticeFor(
        block.apps.map(({ identifier }) => identifier),
      );
      const details = (
        <ActivityBlockDetails
          details={blockDetails(block.sources, titleOf)}
          range={range}
          sourceAppVisuals={sourceAppVisuals}
          titlesNotice={titlesNotice}
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
      // A block is named by the topic that sets its colour: the app its topic
      // was held in, with its icon, or a call there; time it took in from
      // other apps is listed under it, never named.
      const { topicApp } = block;
      let appName: string | null = null;
      let appIcon: ReactNode = null;
      if (topicApp?.call === true) {
        appName = t("callIn", { app: topicApp.appName });
        appIcon = (
          <PhoneIcon aria-hidden="true" className="size-3.5 shrink-0" />
        );
      } else if (topicApp !== null) {
        appName = topicApp.appName;
        appIcon = (
          <ActivitySourceIcon
            appIdentifier={topicApp.appIdentifier}
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
      const switching = block.matter === null && block.topic === null;
      // The apps are the caption unless the block is named by its one app.
      const namedByApp =
        block.matter === null && topicApp !== null && block.apps.length === 1;
      return {
        accessibleLabel: switching
          ? t("mixedActivityLabel", { apps, range })
          : `${[topic, detail, namedByApp ? null : apps]
              .filter((part) => part !== null)
              .join(" · ")}, ${range}`,
        caption: namedByApp ? range : apps,
        endMs: block.drawnEndMs,
        id: block.id,
        // Time no one topic held reads as quick switching, in the quiet tone.
        kind: block.topic === null ? "mixed" : "segment",
        startMs: block.startMs,
        title: (
          <span className="flex min-w-0 items-center gap-1.5">
            {appIcon}
            <bdi className="truncate">{label}</bdi>
          </span>
        ),
        tone: activityTone(block),
        // The notice holds an action, so the hover must stay reachable.
        tooltip: {
          content: details,
          type: titlesNotice === null ? "text" : "actions",
        },
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
    // Each piece shows its own time; the matter's total is its card's.
    const narrative = narrativeFor(suggestion).trim();
    for (const piece of suggestionPieces(suggestion)) {
      const range = formatRange(piece.startMs, piece.endMs);
      const duration = minutesLabel(piece.minutes);
      entries.push({
        accessibleLabel: t("suggestionPieceLabel", {
          duration,
          hours: roundedHours,
          matter: name,
          range,
        }),
        // The description reads under the time, as on a timesheet.
        ...(narrative.length > 0 ? { caption: <bdi>{narrative}</bdi> } : {}),
        endMs: piece.endMs,
        id: `${suggestion.id}:${String(piece.startMs)}`,
        kind: "entry",
        onActivate: () => onActivate(suggestion),
        startMs: piece.startMs,
        state: "suggestion",
        title: (
          <SuggestionPieceLabel
            duration={duration}
            matter={name}
            range={range}
          />
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

/** A matter's time in its colour; other time in its topic's, so one document
 * reads alike all day; time no one topic held in the neutral tone. */
function activityTone(
  block: Pick<ActivityBlock, "matter" | "topic">,
): DayCalendarTone {
  if (block.matter !== null) {
    return matterTone(block.matter);
  }
  return block.topic === null
    ? { type: "neutral" }
    : { key: block.topic, type: "topic" };
}

function matterTone(
  matter: Pick<DesktopMatter, "color" | "id"> | null,
): DayCalendarTone {
  return matter === null
    ? { type: "neutral" }
    : { color: matter.color, matterId: matter.id, type: "matter" };
}

/** The titles a card's description names: those whose time went to its
 * matter, the longest first in each app. */
const matterTitles = (suggestion: ActivitySuggestion, matterId: string) =>
  suggestion.evidence.flatMap(({ details }) =>
    details
      .filter(({ matter }) => matter?.id === matterId)
      .slice(0, EVIDENCE_DETAIL_LIMIT)
      .map(({ title }) => title),
  );

/** Why time recorded no titles, with the action that changes it: for an
 * Activity block's apps, and for a suggestion's empty Titles tab. Browsers
 * turned on from here keep their confirmation while the day is open. */
const useTitlesNotices = (
  snapshot: ActivityDaySnapshot,
  onCaptureCommand: CaptureCommandRunner,
) => {
  const t = useTranslations("activity");
  const { record, turnedOn } = useBrowserTitleRequests(onCaptureCommand);
  const browsersNotice = (browsers: readonly ExplainedBrowser[]) =>
    browsers.length === 0 ? null : (
      <BrowserTitlesNotice browsers={browsers} onRecord={record} />
    );
  const forSuggestion = (suggestion: ActivitySuggestion) => {
    const reason = missingTitlesReason(
      snapshot,
      suggestion.apps.map(({ identifier }) => identifier),
      turnedOn,
    );
    switch (reason.type) {
      case "none":
        return null;
      case "accessibilityRequired":
        return (
          <div className="flex flex-col items-start gap-1.5">
            <p>{t("titlesNeedAccessibility")}</p>
            <OpenAccessibilitySettingsButton
              onCommand={onCaptureCommand}
              variant="outline"
            />
          </div>
        );
      case "browsers":
        return browsersNotice(reason.browsers);
      default:
        reason satisfies never;
        return panic("Unhandled missing titles reason");
    }
  };
  return {
    forApps: (identifiers: readonly string[]) =>
      browsersNotice(explainedBrowsers(snapshot, identifiers, turnedOn)),
    forSuggestion,
  };
};

/** Browsers turned on from this window while the day is open. A repeated
 * press while one request is in flight sends nothing. */
const useBrowserTitleRequests = (onCaptureCommand: CaptureCommandRunner) => {
  const pending = useRef(new Set<string>());
  const [turnedOn, setTurnedOn] = useState<ReadonlySet<string>>(new Set());
  const settle = (identifier: string) => pending.current.delete(identifier);
  const record = ({ identifier, name }: ActivityAppExclusion) => {
    if (pending.current.has(identifier)) {
      return;
    }
    pending.current.add(identifier);
    onCaptureCommand(
      "activity_set_browser_title_capture",
      { identifier, name, enabled: true },
      () => {
        settle(identifier);
        setTurnedOn((current) => new Set([...current, identifier]));
      },
      () => {
        settle(identifier);
      },
    );
  };
  return { record, turnedOn };
};

type SuggestionDraftsOptions = {
  drafting: BillingDraftSettingsControl;
  date: string;
  timeZone: string;
  captureDetails: boolean;
};

/** What a written draft leaves on a card. */
type Drafted = {
  earlierEntries: CardDraft["earlierEntries"];
  flags: CardDraft["flags"];
  /** The server's result, which a refinement sends back unchanged. */
  result: CardDraft["result"];
  /** A split or move the draft proposes for the matter it was written for. */
  structure: CardDraft["structure"];
  /** The matter the draft was written for. */
  matterId: string;
  /** Why the last refinement failed, until the next one. */
  refineFailure: DraftFailureKind | null;
};

/** A suggestion's stella AI description. */
type DraftStatus =
  | { type: "template" }
  | { request: string; type: "writing" }
  | (Drafted & { type: "drafted" })
  | { drafted: Drafted; request: string; type: "refining" }
  /** A refinement waiting for the user: shown as a change to `base`.
   * Dismissing it keeps `previous`; accepting it moves to `drafted`. */
  | {
      base: string;
      drafted: Drafted;
      previous: Drafted;
      proposal: CardDraft;
      type: "proposed";
    }
  | { kind: DraftFailureKind; type: "failed" };

type DraftAnswer =
  | { draft: CardDraft; type: "drafted" }
  | { kind: DraftFailureKind; type: "failed" }
  /** Consent changed meanwhile; nothing to show. */
  | { type: "quiet" };

const draftedFrom = (draft: CardDraft, matterId: string): Drafted => ({
  earlierEntries: draft.earlierEntries,
  flags: draft.flags,
  structure: draft.structure,
  result: draft.result,
  matterId,
  refineFailure: null,
});

/** What stella AI changes on a card; a `null` billable keeps the card's. */
type AiChange = Pick<SuggestionEdit, "narrative" | "classification"> & {
  billable: boolean | null;
};

/** A card with AI text applied, keeping what it replaces for Undo. */
const withAiText = (
  edit: SuggestionEdit,
  change: AiChange,
): SuggestionEdit => ({
  ...edit,
  narrative: change.narrative.slice(0, DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH),
  classification: change.classification,
  billable: change.billable ?? edit.billable,
  written: edit.written + 1,
  undo: {
    narrative: edit.narrative,
    classification: edit.classification,
    billable: edit.billable,
  },
});

/** What a card's stella AI area shows. */
const draftAssistView = ({
  settings,
  status,
  edit,
  template,
}: {
  settings: BillingDraftSettings;
  status: DraftStatus;
  edit: SuggestionEdit;
  template: string;
}): DraftAssistView => {
  if (settings.type !== "ready" || settings.mode === "off") {
    return { type: "hidden" };
  }
  switch (status.type) {
    case "writing":
      return { type: "writing" };
    case "refining":
      return { type: "refining" };
    case "proposed":
      return {
        after: status.proposal.narrative,
        before: status.base,
        type: "proposal",
      };
    case "template":
    case "drafted":
    case "failed":
      break;
    default:
      status satisfies never;
      return panic("Unhandled stella AI draft status");
  }
  if (edit.matter === null) {
    return { type: "needsMatter" };
  }
  if (settings.consent !== "granted") {
    return {
      pending: settings.consent === "pending-grant",
      type: "consent",
    };
  }
  if (status.type === "failed") {
    return { kind: status.kind, type: "failed" };
  }
  return {
    canUndo: edit.undo !== null,
    canRestoreTemplate: edit.narrative !== template,
    drafted: status.type === "drafted",
    refineFailure: status.type === "drafted" ? status.refineFailure : null,
    type: "ready",
  };
};

/**
 * Each suggestion's editable fields and its stella AI description. Nothing
 * about a suggestion leaves the window until the user has consented on the
 * server; then a card with a matter is drafted as it opens, and text the user
 * typed meanwhile always wins over the draft. A refinement is a proposal the
 * user accepts or dismisses; the last applied change can be undone.
 */
function useSuggestionDrafts({
  drafting,
  date,
  timeZone,
  captureDetails,
}: SuggestionDraftsOptions) {
  const t = useTranslations("activity");
  const format = useFormatter();
  const [edits, setEdits] = useState<Record<string, SuggestionEdit>>({});
  const [statuses, setStatuses] = useState<Record<string, DraftStatus>>({});

  // The template never exceeds what a time entry accepts. A card that starts
  // on no matter starts with no description: its time is not one matter's
  // work until the user says whose it is.
  const template = (suggestion: ActivitySuggestion) => {
    if (suggestion.matter === null) {
      return "";
    }
    const titles = matterTitles(suggestion, suggestion.matter.id);
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
      // Billable time is a matter's time.
      billable: suggestion.matter !== null,
      matter: suggestion.matter,
      narrative: template(suggestion),
      written: 0,
      classification: null,
      undo: null,
    };
  const statusFor = (suggestion: ActivitySuggestion): DraftStatus =>
    statuses[suggestion.id] ?? { type: "template" };
  const setStatus = (id: string, status: DraftStatus) =>
    setStatuses((current) => ({ ...current, [id]: status }));
  /** Applies `status` only while `request` is still the latest request. */
  const settle = (id: string, request: string, status: DraftStatus) =>
    setStatuses((current) => {
      const latest = current[id];
      return latest !== undefined &&
        "request" in latest &&
        latest.request === request
        ? { ...current, [id]: status }
        : current;
    });
  const { settings } = drafting;
  const available = settings.type === "ready" && settings.mode !== "off";
  const consented = settings.type === "ready" && settings.consent === "granted";

  /** Applies AI text to a card, keeping what it replaces for Undo; `when`
   * decides against the card as it is when the change lands. */
  const apply = (
    suggestion: ActivitySuggestion,
    change: AiChange,
    when: (edit: SuggestionEdit) => boolean = () => true,
  ) =>
    setEdits((current) => {
      const edit = current[suggestion.id] ?? editFor(suggestion);
      return when(edit)
        ? { ...current, [suggestion.id]: withAiText(edit, change) }
        : current;
    });

  // Only this entry's matter, date, duration, app names and, when titles
  // are recorded, the names the card shows leave the window.
  const send = async (
    suggestion: ActivitySuggestion,
    matterId: string,
    steering?: { steer: string; previousResult?: CardDraft["result"] },
  ): Promise<DraftAnswer> => {
    const outcome = await drafting.consent.request({
      entries: [
        cardDraftEntry({
          suggestion,
          matterId,
          date,
          timezone: timeZone,
          captureDetails,
        }),
      ],
      ...steering,
    });
    switch (outcome.type) {
      case "blocked":
      case "discarded":
        return { type: "quiet" };
      case "completed":
        break;
      default:
        outcome satisfies never;
        return panic("Unhandled drafting outcome");
    }
    if (outcome.response.isErr()) {
      const kind = outcome.response.error;
      // The server's switch or consent changed: read them again.
      if (kind === "off" || kind === "consentRequired") {
        drafting.reload();
      }
      return { kind, type: "failed" };
    }
    const draft = cardDraftFrom(outcome.response.value, {
      matterId,
      durationMinutes: suggestion.roundedTenths * 6,
    });
    return draft === null
      ? { kind: "failed", type: "failed" }
      : { draft, type: "drafted" };
  };

  const draft = (suggestion: ActivitySuggestion) => {
    const { matter, narrative: before } = editFor(suggestion);
    if (matter === null || !available) {
      return;
    }
    const request = crypto.randomUUID();
    const id = suggestion.id;
    setStatus(id, { request, type: "writing" });
    void send(suggestion, matter.id).then((answer) => {
      switch (answer.type) {
        case "quiet":
          settle(id, request, { type: "template" });
          return undefined;
        case "failed":
          settle(id, request, { kind: answer.kind, type: "failed" });
          return undefined;
        case "drafted":
          break;
        default:
          answer satisfies never;
          return panic("Unhandled draft answer");
      }
      settle(id, request, {
        ...draftedFrom(answer.draft, matter.id),
        type: "drafted",
      });
      // A classification belongs to the matter it was drafted for, and text
      // the user typed meanwhile wins over the draft.
      apply(
        suggestion,
        {
          narrative: answer.draft.narrative,
          classification: answer.draft.classification,
          billable: answer.draft.billable,
        },
        (edit) => edit.matter?.id === matter.id && edit.narrative === before,
      );
      return undefined;
    });
  };

  const refine = (
    suggestion: ActivitySuggestion,
    steer: string,
    remember: boolean,
  ) => {
    const status = statusFor(suggestion);
    const { matter, narrative: base } = editFor(suggestion);
    if (status.type !== "drafted" || matter === null || !available) {
      return;
    }
    if (remember) {
      void drafting.setPreference(steer);
    }
    const request = crypto.randomUUID();
    const id = suggestion.id;
    const drafted: Drafted = { ...status, refineFailure: null };
    setStatus(id, { drafted, request, type: "refining" });
    // A draft for another matter cannot be refined; a new matter is drafted
    // afresh with the same instruction.
    const steering =
      drafted.matterId === matter.id
        ? { steer, previousResult: drafted.result }
        : { steer };
    void send(suggestion, matter.id, steering).then((answer) => {
      switch (answer.type) {
        case "quiet":
          settle(id, request, { ...drafted, type: "drafted" });
          return undefined;
        case "failed":
          settle(id, request, {
            ...drafted,
            refineFailure: answer.kind,
            type: "drafted",
          });
          return undefined;
        case "drafted":
          settle(id, request, {
            base,
            drafted: draftedFrom(answer.draft, matter.id),
            previous: drafted,
            proposal: answer.draft,
            type: "proposed",
          });
          return undefined;
        default:
          answer satisfies never;
          return panic("Unhandled draft answer");
      }
    });
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
    /** With consent, a card the user has not touched is drafted as it opens. */
    opened: (suggestion: ActivitySuggestion) => {
      if (
        consented &&
        edits[suggestion.id] === undefined &&
        statusFor(suggestion).type === "template"
      ) {
        draft(suggestion);
      }
    },
    draft,
    refine,
    /** Consent is granted on the server; the card drafts once it is. */
    allow: (suggestion: ActivitySuggestion) => {
      void drafting.setConsent("granted").then((granted) => {
        if (granted) {
          draft(suggestion);
        }
        return undefined;
      });
    },
    acceptProposal: (suggestion: ActivitySuggestion) => {
      const status = statusFor(suggestion);
      if (status.type !== "proposed") {
        return;
      }
      const { matter } = editFor(suggestion);
      apply(suggestion, {
        narrative: status.proposal.narrative,
        classification:
          matter?.id === status.drafted.matterId
            ? status.proposal.classification
            : null,
        billable: status.proposal.billable,
      });
      setStatus(suggestion.id, { ...status.drafted, type: "drafted" });
    },
    dismissProposal: (suggestion: ActivitySuggestion) => {
      const status = statusFor(suggestion);
      if (status.type === "proposed") {
        // The draft stays the one the user had; the next refinement builds
        // on it.
        setStatus(suggestion.id, { ...status.previous, type: "drafted" });
      }
    },
    undo: (suggestion: ActivitySuggestion) =>
      setEdits((current) => {
        const edit = current[suggestion.id] ?? editFor(suggestion);
        return edit.undo === null
          ? current
          : {
              ...current,
              [suggestion.id]: { ...edit, ...edit.undo, undo: null },
            };
      }),
    /** Puts the template back; Undo returns the text it replaced. */
    restoreTemplate: (suggestion: ActivitySuggestion) =>
      setEdits((current) => {
        const edit = current[suggestion.id] ?? editFor(suggestion);
        return {
          ...current,
          [suggestion.id]: {
            ...edit,
            narrative: template(suggestion),
            classification: null,
            undo: {
              narrative: edit.narrative,
              classification: edit.classification,
              billable: edit.billable,
            },
          },
        };
      }),
    earlierEntries: (suggestion: ActivitySuggestion) => {
      const status = statusFor(suggestion);
      return status.type === "drafted" ? status.earlierEntries : [];
    },
    flags: (suggestion: ActivitySuggestion) => {
      const status = statusFor(suggestion);
      return status.type === "drafted" ? status.flags : [];
    },
    /** The split or move on offer, while the card keeps the matter it was
     * drafted for. */
    structure: (suggestion: ActivitySuggestion) => {
      const status = statusFor(suggestion);
      return status.type === "drafted" &&
        editFor(suggestion).matter?.id === status.matterId
        ? status.structure
        : null;
    },
    view: (suggestion: ActivitySuggestion) =>
      draftAssistView({
        settings,
        status: statusFor(suggestion),
        edit: editFor(suggestion),
        template: template(suggestion),
      }),
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
