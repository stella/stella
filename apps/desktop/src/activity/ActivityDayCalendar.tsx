import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic } from "better-result";
import { useFormatter, useLocale, useTranslations } from "use-intl";

import { DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH } from "@stll/api-contract/desktop-time-entries";
import type {
  DesktopDayEntriesResponse,
  DesktopMatter,
  DesktopMatterCandidatesResponse,
  DesktopMatterResolution,
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
import { MatterIcon } from "@stll/ui/matter-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Separator } from "@stll/ui/separator";
import { TruncatedText } from "@stll/ui/truncated-text";

import { callEventTitle } from "./activity-calendar-events";
import type { CalendarEventBlock } from "./activity-calendar-events";
import {
  activityBlocks,
  blockDetails,
  calendarHours,
  contiguousRuns,
  draftedBlocks,
  manualSuggestion,
  matchedSuggestions,
  nextSuggestion,
  segmentTitles,
  suggestionPieces,
  suggestionSummary,
  toSuggestion,
  UNAVAILABLE_MATTER_TOPIC,
} from "./activity-calendar-logic";
import type {
  ActivityBlock,
  ActivitySuggestion,
  SuggestionSummary,
} from "./activity-calendar-logic";
import { calendarDate, MINUTE_MS, timedSegments } from "./activity-logic";
import { outageRanges, STOP_REASON_KEYS } from "./activity-outages";
import type { OutageRange } from "./activity-outages";
import type {
  ActivityAppExclusion,
  ActivityDaySnapshot,
  ActivityManualAssignment,
} from "./activity-types";
import {
  GAP_DISPLAY_KEYS,
  GAP_END_KEYS,
  unrecordedRanges,
} from "./activity-unrecorded";
import type { UnrecordedRange } from "./activity-unrecorded";
import {
  CalendarEventsNotice,
  useDayCalendarEvents,
} from "./ActivityCalendarEvents";
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
  restoredEdit,
  revertActions,
  structureItems,
} from "./billing-draft-logic";
import type {
  CardDraft,
  CardDraftTarget,
  DraftFailureKind,
} from "./billing-draft-logic";
import { useBillingDraftSettings } from "./billing-draft-settings";
import type {
  BillingDraftSettings,
  BillingDraftSettingsControl,
} from "./billing-draft-settings";
import type { CaptureModeCommand } from "./capture-modes";
import {
  BRIEF_MS,
  EVIDENCE_DETAIL_LIMIT,
  matchDay,
  recordedMatterIds,
  segmentEvidence,
  segmentRanges,
  unresolvedMatterIds,
} from "./day-review-logic";
import type {
  DayEntriesRead,
  DayReviewGroup,
  MatchedSegment,
} from "./day-review-logic";
import {
  acceptProposal,
  declineProposal,
  EMPTY_MATTER_LEARNING,
  forgetMatters,
  learn,
  ruleProposals,
  suggestedMatterIds,
} from "./matter-learning";
import { useMatterLearning } from "./matter-learning-store";
import { resolveMatters } from "./matter-resolve";
import { SuggestionPieceLabel } from "./SuggestionPieceLabel";
import { explainedBrowsers, missingTitlesReason } from "./title-capture-logic";
import type { ExplainedBrowser } from "./title-capture-logic";
import {
  useBilledLabel,
  useDurationLabel,
  useMinutesLabel,
} from "./use-duration-label";
import type { EntryBilling } from "./use-duration-label";

const ACTIVITY_COLUMN_ID = "activity";
const ENTRIES_COLUMN_ID = "entries";

type CandidateState =
  | { type: "loading" }
  | { type: "failed" }
  | ({
      type: "ready";
      resolved: DesktopMatterResolution[];
    } & DesktopMatterCandidatesResponse);
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

/** Why nothing on the day can change now, if anything stops it. While
 * Activity cannot record, its history is read-only: every action that
 * would change the review says so, as the stop notice does. */
const getEditingDisabledReason = (
  submission: Submission,
  stoppedReason: ActivityDaySnapshot["stoppedReason"],
  t: ReturnType<typeof useTranslations<"activity">>,
): string | undefined => {
  if (stoppedReason !== null) {
    return t("stoppedNotice", { reason: t(STOP_REASON_KEYS[stoppedReason]) });
  }
  switch (submission.type) {
    case "submitting":
      return t("creatingDrafts");
    case "retry":
      return t("pendingRetry");
    case "editing":
    case "saved":
      return undefined;
    default:
      submission satisfies never;
      return panic("Unhandled activity submission state");
  }
};

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

/** Each app with its time and the title it spent longest on, then how many
 * apps past the limit are left out. */
const BlockDetailRows = ({
  details,
  sourceAppVisuals,
}: {
  details: ReturnType<typeof blockDetails>;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
}) => {
  const t = useTranslations("activity");
  const durationLabel = useDurationLabel();
  return (
    <>
      <ul className="flex flex-col gap-1.5">
        {details.rows.map((row) => (
          <li className="flex items-start gap-2" key={row.identifier}>
            <ActivitySourceIcon
              appIdentifier={row.identifier}
              sourceAppVisuals={sourceAppVisuals}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-baseline justify-between gap-3">
                <TruncatedText className="font-medium" render={<bdi />}>
                  {row.name}
                </TruncatedText>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {durationLabel(row.durationMs)}
                </span>
              </div>
              {row.title === null ? null : (
                <TruncatedText
                  className="text-muted-foreground"
                  render={<bdi />}
                >
                  {row.title}
                </TruncatedText>
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
    </>
  );
};

/** An Activity block's hover: its range, then the apps its stated time was
 * spent in, then the brief stretches with no matter it took in, then why a
 * browser in it recorded no titles. */
const ActivityBlockDetails = ({
  details,
  joined,
  range,
  sourceAppVisuals,
  titlesNotice,
}: {
  details: ReturnType<typeof blockDetails>;
  /** `null` when the block took in nothing it does not count. */
  joined: ReturnType<typeof blockDetails> | null;
  range: string;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
  titlesNotice: ReactElement | null;
}) => {
  const t = useTranslations("activity");
  return (
    <div className="flex w-64 flex-col gap-2 py-0.5 text-xs">
      <p className="text-muted-foreground tabular-nums">{range}</p>
      <BlockDetailRows details={details} sourceAppVisuals={sourceAppVisuals} />
      {joined === null ? null : (
        <>
          <Separator />
          <p className="text-muted-foreground">{t("joinedActivity")}</p>
          <BlockDetailRows
            details={joined}
            sourceAppVisuals={sourceAppVisuals}
          />
        </>
      )}
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
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 tabular-nums">
      <div className="flex items-center gap-6">
        {[
          { label: t("activeLabel"), ms: activeMs },
          { label: t("draftedLabel"), ms: draftedMs },
        ].map(({ label, ms }) => (
          <div key={label}>
            <b className="block text-base font-semibold">{hours(ms)}</b>
            <span className="text-muted-foreground text-xs">{label}</span>
          </div>
        ))}
      </div>
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
            disabledReason={t("creatingDrafts")}
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
  /** Opens the member's own time for the day in stella web. */
  onOpenDayTime: () => void;
  onReviewStatusChange: (status: ActivityReviewStatus) => void;
};

type SuggestionAcceptanceInput = {
  editable: boolean;
  narratives: ReturnType<typeof useSuggestionDrafts>;
  submitBatch: ReturnType<typeof useBatchSubmission>["submitBatch"];
  date: ActivityDaySnapshot["date"];
  timeZone: string;
  onSaved: (
    suggestion: ActivitySuggestion,
    items: readonly BatchItem[],
  ) => void;
};

/** Accepting a reviewed suggestion, whole or split, saves it as one confirmed
 * batch; once saved, `onSaved` hears which entries it became. */
const suggestionAcceptance = ({
  editable,
  narratives,
  submitBatch,
  date,
  timeZone,
  onSaved,
}: SuggestionAcceptanceInput) => {
  const accept = (suggestion: ActivitySuggestion) => {
    const edit = narratives.editFor(suggestion);
    if (
      !editable ||
      edit.matter === null ||
      edit.narrative.trim().length === 0 ||
      suggestion.workedMinutes === 0
    ) {
      return;
    }
    // One confirmed entry per batch: the batch path keeps the idempotency
    // key and the stored pending request for this single acceptance.
    submitBatch(
      {
        idempotencyKey: crypto.randomUUID(),
        items: [
          cardEntryItem({
            edit,
            matterId: edit.matter.id,
            suggestion,
            date,
            timeZone,
          }),
        ],
      },
      afterSaved(suggestion),
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
      suggestion.workedMinutes === 0
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
          durationMinutes: suggestion.workedMinutes,
          ranges: suggestion.ranges,
          date,
          timezoneId: timeZone,
        }),
      },
      afterSaved(suggestion),
    );
  };
  const afterSaved =
    (suggestion: ActivitySuggestion) => (items: readonly BatchItem[]) => {
      onSaved(suggestion, items);
    };
  return { accept, acceptStructure };
};

export const ActivityDayCalendar = ({
  header,
  notice,
  snapshot,
  preferences,
  onPreferencesChange,
  onCopy,
  onCaptureCommand,
  onOpenDayTime,
  onReviewStatusChange,
}: ActivityDayCalendarProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const locale = useLocale();
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  const elsewhere = useRecordedElsewhere(snapshot, onOpenDayTime);
  const [localDrafts, setLocalDrafts] = useState<DraftedEntries>([]);
  const { submission, submitBatch, errorMessage } = useBatchSubmission({
    date: snapshot.date,
    pendingBatch: snapshot.pendingBatch,
    onReviewStatusChange,
    onDrafted: (drafted) =>
      setLocalDrafts((current) => [...current, ...drafted]),
  });
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(new Set());
  const review = useDayReview({ leftOut, localDrafts, nowMs, snapshot });
  const { candidates, day, suggestions } = review;
  const [openCard, setOpenCard] = useState<OpenCard>({ type: "closed" });
  const titlesNotices = useTitlesNotices(snapshot, onCaptureCommand);

  const timeZone = Temporal.Now.timeZoneId();
  const outages = outageRanges(snapshot.outages);
  const unrecorded = unrecordedRanges(outages, snapshot.gaps, day.segments);
  const calendar = useDayCalendarEvents(snapshot, day.segments);
  const editingDisabledReason = getEditingDisabledReason(
    submission,
    snapshot.stoppedReason,
    t,
  );
  const editable = editingDisabledReason === undefined;
  const drafting = useBillingDraftSettings(true);
  const narratives = useSuggestionDrafts({
    drafting,
    date: snapshot.date,
    timeZone,
    captureDetails: snapshot.captureDetails,
  });

  const rangeSuggestion = ({ id, range }: RangeCard) =>
    manualSuggestion({
      drafted: review.draftedEntries,
      id,
      range,
      segments: day.segments,
    });
  const openSuggestion = cardSuggestion(openCard, suggestions, rangeSuggestion);

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
  const { accept, acceptStructure } = suggestionAcceptance({
    editable,
    narratives,
    submitBatch,
    date: snapshot.date,
    timeZone,
    onSaved: (suggestion, items) => {
      review.learning.learnFrom(suggestion, items);
      openNext(suggestion);
    },
  });
  const reject = (suggestion: ActivitySuggestion) => {
    if (suggestion.type === "matched") {
      setLeftOut((current) => new Set([...current, suggestion.id]));
    }
    openNext(suggestion);
  };

  const minutesLabel = useMinutesLabel();
  const summaryLabel = useSummaryLabel(entryBilling(candidates));
  // Matters group the day, so its blocks wait for them: drawn before they
  // arrive, every block a matter claims would be drawn again as another one,
  // under a pointer or focus already on it. The grid shimmers meanwhile where
  // activity was recorded.
  const columns = useCalendarColumns({
    phase: candidates.type === "loading" ? "pending" : "ready",
    segments: day.segments,
    unrecorded,
    granularity: preferences.granularity,
    sourceAppVisuals: snapshot.sourceAppVisuals,
    rangeSelection: editable,
    draftedEntries: review.draftedEntries,
    suggestions,
    narrativeFor: (suggestion) => narratives.editFor(suggestion).narrative,
    onActivate: (suggestion) =>
      open({ id: suggestion.id, type: "suggestion" }, suggestion),
    titlesNoticeFor: titlesNotices.forApps,
    calendarColumn: calendar.column,
    calendarEvents: calendar.lane.timed,
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
        recordedElsewhere={{
          ...elsewhere,
          draftedEntries: review.draftedEntries,
        }}
        candidates={review.matters}
        editingDisabledReason={editingDisabledReason}
        timeLabel={summaryLabel(suggestionSummary(openSuggestion))}
        sourceAppVisuals={snapshot.sourceAppVisuals}
        titlesNotice={titlesNotices.forSuggestion(openSuggestion)}
        assist={narratives.view(openSuggestion)}
        earlierEntries={narratives.earlierEntries(openSuggestion)}
        flags={narratives.flags(openSuggestion)}
        codeNames={narratives.codeNames(openSuggestion)}
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
        onIncludeSlivers={() => review.additions.includeSlivers(openSuggestion)}
        onClose={() => setOpenCard({ type: "closed" })}
        onCopy={async () =>
          // Resolves once the copy settles; a failed copy is reported by the
          // command runner and resolves false.
          new Promise<boolean>((resolve) => {
            const edit = narratives.editFor(openSuggestion);
            onCopy(
              `${edit.matter?.name ?? t("newEntry")} · ${format.dateTime(calendarDate(snapshot.date), { dateStyle: "medium" })} · ${minutesLabel(openSuggestion.workedMinutes)}: ${edit.narrative}`,
              resolve,
            );
          })
        }
      />
    );

  return (
    <div className="flex flex-col gap-4">
      {/* The totals keep a row of their own, so the header's height does
          not depend on how long its words are in a language. */}
      <div className="flex flex-col gap-3">
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
      <DayStatus
        empty={day.segments.length === 0}
        outages={outages}
        snapshot={snapshot}
      />
      {/* Matters cannot be read while Activity cannot record; the stop
          notice already says why. */}
      {candidates.type === "failed" && snapshot.stoppedReason === null ? (
        <CandidatesFailedAlert onRetry={review.refreshCandidates} />
      ) : null}
      <MatterLearningNotice learning={review.learning} day={day} />
      <CalendarEventsNotice calendar={calendar} />
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
            ...unrecorded.flatMap(({ startMs, endMs }) => [startMs, endMs]),
            ...calendar.instants,
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
      <BriefTouches
        touches={review.briefTouches}
        editingDisabledReason={editingDisabledReason}
        onAdd={(touch) => {
          const added = review.additions.addTouch(touch);
          open({ id: added.id, type: "suggestion" }, added);
        }}
      />
      <p className="text-muted-foreground text-xs">{t("calendarHint")}</p>
    </div>
  );
};

type CardEntryOptions = {
  edit: SuggestionEdit;
  /** The edit's matter, once the card has one. */
  matterId: string;
  suggestion: ActivitySuggestion;
  date: string;
  timeZone: string;
};

/** The one entry a confirmed card saves. It carries the minutes worked; the
 * server bills them under the organization's minimum unit. */
const cardEntryItem = ({
  edit,
  matterId,
  suggestion,
  date,
  timeZone,
}: CardEntryOptions): BatchItem => ({
  entry: {
    matterId,
    dateWorked: date,
    timezoneId: timeZone,
    durationMinutes: suggestion.workedMinutes,
    narrative: edit.narrative,
    billable: edit.billable,
    ...(edit.classification === null
      ? {}
      : { classification: edit.classification }),
  },
  ranges: suggestion.ranges,
});

/** The organization's minimum billing unit, once the candidates hold it. */
const entryBilling = (candidates: CandidateState): EntryBilling =>
  candidates.type === "ready"
    ? { minimumUnitMinutes: candidates.timeMinimumUnitMinutes, type: "known" }
    : { type: "unknown" };

type DayReviewOptions = {
  leftOut: ReadonlySet<string>;
  localDrafts: DraftedEntries;
  nowMs: number;
  snapshot: ActivityDaySnapshot;
};

/** The day matched (`useDayMatters`), with what the member took in by their
 * own action, as suggestions and brief touches. */
function useDayReview({
  leftOut,
  localDrafts,
  nowMs,
  snapshot,
}: DayReviewOptions) {
  const additions = useMemberAdditions();
  const draftedEntries = [...snapshot.draftedEntries, ...localDrafts];
  const { learningStore, learnFrom, ...matched } = useDayMatters({
    snapshot,
    manualAssignments: additions.withSlivers(snapshot.manualAssignments),
    draftedEntries,
    nowMs,
  });
  return {
    ...matched,
    additions,
    draftedEntries,
    learning: { learningStore, learnFrom },
    ...additions.review(matched.day, leftOut),
  };
}

/** What the member took in by their own action: brief touches added as
 * entries, and slivers included in a suggestion as assignments to its
 * matter. */
function useMemberAdditions() {
  const [addedTouches, setAddedTouches] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [includedSlivers, setIncludedSlivers] = useState<
    ActivityManualAssignment[]
  >([]);
  /** The day's suggestions with the brief touches added, and the brief
   * touches still listed. */
  const review = (
    { groups, briefTouches }: ReturnType<typeof matchDay>,
    leftOut: ReadonlySet<string>,
  ) => ({
    suggestions: matchedSuggestions(
      [...groups, ...briefTouches.filter(({ id }) => addedTouches.has(id))],
      leftOut,
    ),
    briefTouches: briefTouches.filter(
      ({ id }) => !addedTouches.has(id) && !leftOut.has(id),
    ),
  });
  /** Adds a brief touch and returns its suggestion, for its card to open. */
  const addTouch = (touch: DayReviewGroup) => {
    setAddedTouches((current) => new Set([...current, touch.id]));
    return toSuggestion(touch);
  };
  // The card's include action is disabled while editing is.
  const includeSlivers = ({ matter, slivers }: ActivitySuggestion) => {
    if (matter === null) {
      return;
    }
    setIncludedSlivers((current) => [
      ...current,
      ...segmentRanges(slivers).map((range) => ({
        ...range,
        matterId: matter.id,
        matter: {
          id: matter.id,
          name: matter.name,
          reference: matter.reference,
          color: matter.color,
          clientName: matter.clientName,
        },
      })),
    ]);
  };
  /** The stored assignments with the included slivers. */
  const withSlivers = (stored: readonly ActivityManualAssignment[]) => [
    ...stored,
    ...includedSlivers,
  ];
  return { addTouch, includeSlivers, review, withSlivers };
}

/** Matters recorded too briefly to suggest on their own, each with the one
 * action that adds it as an entry of the least time an entry holds. */
const BriefTouches = ({
  touches,
  editingDisabledReason,
  onAdd,
}: {
  touches: readonly DayReviewGroup[];
  editingDisabledReason: string | undefined;
  onAdd: (touch: DayReviewGroup) => void;
}) => {
  const t = useTranslations("activity");
  const durationLabel = useDurationLabel();
  const minutesLabel = useMinutesLabel();
  if (touches.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="activity-brief-touches"
      className="flex flex-col gap-1.5 text-xs"
    >
      <h3 className="font-medium" id="activity-brief-touches">
        {t("briefTouches")}
      </h3>
      <p className="text-muted-foreground text-pretty">
        {t("briefTouchesHint", {
          duration: minutesLabel(BRIEF_MS / MINUTE_MS),
        })}
      </p>
      <ul className="flex flex-col gap-1">
        {touches.map((touch) => (
          <li className="flex items-center gap-2" key={touch.id}>
            {touch.matter === null ? null : (
              <MatterIcon matter={touch.matter} className="size-3.5 shrink-0" />
            )}
            <TruncatedText className="min-w-0 flex-1" render={<bdi />}>
              {touch.matter?.name ?? t("newEntry")}
            </TruncatedText>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {durationLabel(touch.durationMs)}
            </span>
            <Button
              disabled={editingDisabledReason !== undefined}
              disabledReason={editingDisabledReason}
              onClick={() => onAdd(touch)}
              size="xs"
              variant="ghost"
            >
              {t("addBriefTouch", {
                duration: minutesLabel(touch.workedMinutes),
              })}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
};

const CandidatesFailedAlert = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations("activity");
  return (
    <div
      role="alert"
      className="text-destructive flex items-center gap-2 text-sm"
    >
      {t("candidatesFailed")}
      <Button size="sm" variant="ghost" onClick={onRetry}>
        {t("retry")}
      </Button>
    </div>
  );
};

type DayStatusProps = {
  /** Nothing was recorded on the day. */
  empty: boolean;
  outages: readonly OutageRange[];
  snapshot: ActivityDaySnapshot;
};

/** What the day says above its grid. A day Activity could not record says
 * why, so it never reads as a day off. */
const DayStatus = ({ empty, outages, snapshot }: DayStatusProps) => {
  const t = useTranslations("activity");
  const longest = outages.at(0);
  return (
    <>
      {empty ? (
        <p className="text-muted-foreground text-sm">
          {longest === undefined
            ? t(emptyDayMessage(snapshot))
            : t("emptyStopped", {
                reason: t(STOP_REASON_KEYS[longest.reason]),
              })}
        </p>
      ) : null}
      {snapshot.outages.status === "unreadable" ? (
        <p className="text-muted-foreground text-sm">
          {t("outagesUnreadable")}
        </p>
      ) : null}
    </>
  );
};

/** What a day with nothing recorded says: today, what fills it; another day,
 * only that nothing was recorded. */
const emptyDayMessage = ({
  date,
  recordingStatus,
  today,
}: Pick<ActivityDaySnapshot, "date" | "recordingStatus" | "today">) => {
  if (date !== today) {
    return "empty";
  }
  switch (recordingStatus) {
    case "recording":
      return "emptyToday";
    case "paused":
    case "off":
      return "emptyTodayPaused";
    default:
      recordingStatus satisfies never;
      return panic("Unhandled activity recording status");
  }
};

/** How a card names the minutes its entry claims, with what they bill. */
const ENTRY_TIME_MESSAGES = {
  matched: "entryTimeRecorded",
  manual: "entryTimeSelected",
} as const satisfies Record<SuggestionSummary["source"], string>;

/** What a suggestion card's header says about its time: its range or how
 * many pieces it has, then the minutes the entry claims and, once the
 * organization's minimum unit is known, what they bill under it. */
const useSummaryLabel = (billing: EntryBilling) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const minutesLabel = useMinutesLabel();
  const billedLabel = useBilledLabel();
  const entryTime = ({ source, workedMinutes }: SuggestionSummary) => {
    switch (billing.type) {
      case "unknown":
        return minutesLabel(workedMinutes);
      case "known":
        return t(ENTRY_TIME_MESSAGES[source], {
          billed: billedLabel(workedMinutes, billing.minimumUnitMinutes),
          worked: minutesLabel(workedMinutes),
        });
      default:
        billing satisfies never;
        return panic("Unhandled entry billing");
    }
  };
  return (summary: SuggestionSummary) => {
    switch (summary.type) {
      case "range":
        return t("suggestionRange", {
          range: format.dateTimeRange(summary.startMs, summary.endMs, {
            hour: "numeric",
            minute: "2-digit",
          }),
          time: entryTime(summary),
        });
      case "pieces":
        return t("suggestionPieces", {
          count: summary.count,
          time: entryTime(summary),
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

/** The suggestion an open card shows: a day's suggestion while it is still
 * offered, or the range selected on the grid. */
const cardSuggestion = (
  openCard: OpenCard,
  suggestions: readonly ActivitySuggestion[],
  rangeSuggestion: (card: RangeCard) => ActivitySuggestion,
) => {
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
};

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
  /** `pending` while the matters that group the day are still read. */
  phase: "pending" | "ready";
  segments: readonly MatchedSegment[];
  /** Time Activity could not record, and time with no input. */
  unrecorded: readonly UnrecordedRange<MatchedSegment>[];
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
  /** The Calendar lane beside Activity; `null` while calendar events are
   * off. */
  calendarColumn: DayCalendarColumn | null;
  /** The day's timed events, which name the recorded calls they overlap. */
  calendarEvents: readonly CalendarEventBlock[];
};

/** The Activity column (recorded time), the Calendar lane when calendar
 * events are on, and the Time entries column (created drafts and
 * suggestions). */
function useCalendarColumns({
  phase,
  segments,
  unrecorded,
  granularity,
  sourceAppVisuals,
  rangeSelection,
  draftedEntries,
  suggestions,
  narrativeFor,
  onActivate,
  titlesNoticeFor,
  calendarColumn,
  calendarEvents,
}: CalendarColumnsOptions): DayCalendarColumn[] {
  const t = useTranslations("activity");
  const format = useFormatter();
  const formatRange = (startMs: number, endMs: number) =>
    format.dateTimeRange(startMs, endMs, {
      hour: "numeric",
      minute: "2-digit",
    });
  const durationLabel = useDurationLabel();
  const minutesLabel = useMinutesLabel();
  const activityHeader = { id: ACTIVITY_COLUMN_ID, label: t("title") };
  const entriesHeader = { id: ENTRIES_COLUMN_ID, label: t("timeEntries") };
  if (phase === "pending") {
    // Where activity was recorded is known; what each stretch becomes is not.
    const placeholders = contiguousRuns(segments);
    return [
      { ...activityHeader, placeholders, type: "pending" },
      ...(calendarColumn === null ? [] : [calendarColumn]),
      { ...entriesHeader, placeholders, type: "pending" },
    ];
  }
  const titleOf = segmentTitles(segments);

  /** Unrecorded time, hatched and neutral: a gap only says how long no
   * input came and after what, and offers nothing. */
  const unrecordedBlock = (
    range: UnrecordedRange<MatchedSegment>,
  ): DayCalendarBlock => {
    const formatted = formatRange(range.startMs, range.endMs);
    switch (range.type) {
      case "outage": {
        const reason = t(STOP_REASON_KEYS[range.reason]);
        return {
          accessibleLabel: t("unrecordedLabel", { range: formatted, reason }),
          caption: formatted,
          endMs: range.endMs,
          id: `outage:${String(range.startMs)}:${range.reason}`,
          kind: "unrecorded",
          startMs: range.startMs,
          title: <bdi>{t("unrecorded", { reason })}</bdi>,
          tone: { type: "neutral" },
        };
      }
      case "gap": {
        const duration = durationLabel(range.endMs - range.startMs);
        const item =
          range.after === null
            ? null
            : (titleOf(range.after) ?? range.after.appName);
        const title =
          item === null
            ? t("gap", { duration })
            : t("gapAfter", { duration, item });
        return {
          accessibleLabel: `${title}, ${formatted}`,
          caption: formatted,
          endMs: range.endMs,
          id: `gap:${String(range.startMs)}`,
          kind: "unrecorded",
          startMs: range.startMs,
          title: <bdi>{title}</bdi>,
          tone: { type: "neutral" },
          tooltip: {
            content: (
              <span className="flex flex-col gap-1">
                <span>{formatted}</span>
                <span>{t(GAP_DISPLAY_KEYS[range.display])}</span>
                <span>{t(GAP_END_KEYS[range.endedBy])}</span>
                <span>{t("gapNotCounted")}</span>
              </span>
            ),
            type: "text",
          },
        };
      }
      default:
        range satisfies never;
        return panic("Unhandled unrecorded range");
    }
  };

  const activity = activityBlocks(segments, granularity).map(
    (block): DayCalendarBlock => {
      const range = formatRange(block.startMs, block.endMs);
      const titlesNotice = titlesNoticeFor(
        block.apps.map(({ identifier }) => identifier),
      );
      const joined = new Set(block.joined);
      const details = (
        <ActivityBlockDetails
          details={blockDetails(
            block.sources.filter((segment) => !joined.has(segment)),
            titleOf,
          )}
          joined={
            block.joined.length === 0
              ? null
              : blockDetails(block.joined, titleOf)
          }
          range={range}
          sourceAppVisuals={sourceAppVisuals}
          titlesNotice={titlesNotice}
        />
      );
      const apps = format.list(
        block.apps.map(({ name }) => name),
        { type: "unit" },
      );
      const duration = durationLabel(block.durationMs);
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
      const unavailable = block.topic === UNAVAILABLE_MATTER_TOPIC;
      const topic =
        block.matter?.name ??
        (unavailable ? t("matterUnavailable") : appName) ??
        block.title ??
        t("mixedActivity");
      // A recorded call is the record of a meeting; the calendar event it
      // overlaps only names it.
      const eventTitle =
        topicApp?.call === true ? callEventTitle(block, calendarEvents) : null;
      const detail =
        eventTitle ??
        (block.matter === null && appName === null ? null : block.title);
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
            <TruncatedText hint={false} render={<bdi />}>
              {label}
            </TruncatedText>
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

  for (const range of unrecorded) {
    activity.push(unrecordedBlock(range));
  }

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
    const total = minutesLabel(suggestion.workedMinutes);
    // Each piece shows its own time; the matter's total is its card's.
    const narrative = narrativeFor(suggestion).trim();
    for (const piece of suggestionPieces(suggestion)) {
      const range = formatRange(piece.startMs, piece.endMs);
      const duration = minutesLabel(piece.minutes);
      entries.push({
        accessibleLabel: t("suggestionPieceLabel", {
          duration,
          matter: name,
          range,
          total,
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
      ...activityHeader,
      blocks: activity,
      // Activity is the record; entries are drawn where they are kept.
      rangeSelection: { type: "disabled" },
      type: "blocks",
    },
    ...(calendarColumn === null ? [] : [calendarColumn]),
    {
      ...entriesHeader,
      blocks: entries,
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
  narrativeLanguage: CardDraft["narrativeLanguage"];
  codeNames: CardDraft["codeNames"];
  earlierEntries: CardDraft["earlierEntries"];
  flags: CardDraft["flags"];
  /** The server's result, which a refinement sends back unchanged. */
  result: CardDraft["result"];
  /** A split or move the draft proposes for the matter it was written for. */
  structure: CardDraft["structure"];
  /** The matter the draft was written for. */
  matterId: string;
  /** The minutes the card claimed when the draft was written; its split or
   * move accounts for exactly these. */
  durationMinutes: number;
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
  /** Drafting for `matterId` failed; another matter starts afresh. */
  | { kind: DraftFailureKind; matterId: string; type: "failed" };

type DraftAnswer =
  /** `target` is the matter and minutes the draft was written for. */
  | { draft: CardDraft; target: CardDraftTarget; type: "drafted" }
  | { kind: DraftFailureKind; type: "failed" }
  /** Consent changed meanwhile; nothing to show. */
  | { type: "quiet" };

const draftedFrom = (
  draft: CardDraft,
  { matterId, durationMinutes }: CardDraftTarget,
): Drafted => ({
  narrativeLanguage: draft.narrativeLanguage,
  codeNames: draft.codeNames,
  earlierEntries: draft.earlierEntries,
  flags: draft.flags,
  structure: draft.structure,
  result: draft.result,
  matterId,
  durationMinutes,
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

/** The card's draft while the card keeps the matter it was drafted for. */
const draftForMatter = (status: DraftStatus, edit: SuggestionEdit) =>
  status.type === "drafted" && edit.matter?.id === status.matterId
    ? status
    : null;

/** The draft's split or move, for the matter and the minutes it was drafted
 * for: once included time or a moved range changes the card's minutes, it no
 * longer accounts for them. */
const draftStructure = (
  status: DraftStatus,
  edit: SuggestionEdit,
  { workedMinutes }: Pick<ActivitySuggestion, "workedMinutes">,
) => {
  const drafted = draftForMatter(status, edit);
  return drafted?.durationMinutes === workedMinutes ? drafted.structure : null;
};

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
  if (settings.type !== "ready") {
    return { type: "hidden" };
  }
  if (settings.mode === "off") {
    return { kind: "off", type: "failed" };
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
    return { consent: settings.consent, type: "consent" };
  }
  if (status.type === "failed" && status.matterId === edit.matter.id) {
    return { kind: status.kind, type: "failed" };
  }
  const reverts = revertActions(edit, template);
  return {
    canUndo: reverts.undo,
    canRestoreTemplate: reverts.restoreTemplate,
    draft:
      status.type === "drafted"
        ? { narrativeLanguage: status.narrativeLanguage }
        : null,
    // A refusal names the matter it was refining for.
    refineFailure:
      status.type === "drafted" && status.matterId === edit.matter.id
        ? status.refineFailure
        : null,
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
    // Quoted: titles mix file names, meetings and subjects with their own commas.
    const titles = [
      ...new Set(matterTitles(suggestion, suggestion.matter.id)),
    ].map((title) => t("narrativeTitle", { title }));
    const text =
      titles.length > 0
        ? t("narrativeEvidence", {
            evidence: format.list(titles, { type: "conjunction" }),
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
    const target = { matterId, durationMinutes: suggestion.workedMinutes };
    const draft = cardDraftFrom(outcome.response.value, target);
    return draft === null
      ? { kind: "failed", type: "failed" }
      : { draft, target, type: "drafted" };
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
          settle(id, request, {
            kind: answer.kind,
            matterId: matter.id,
            type: "failed",
          });
          return undefined;
        case "drafted":
          break;
        default:
          answer satisfies never;
          return panic("Unhandled draft answer");
      }
      settle(id, request, {
        ...draftedFrom(answer.draft, answer.target),
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
            drafted: draftedFrom(answer.draft, answer.target),
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
            ...restoredEdit(edit, template(suggestion)),
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
    /** The names of the codes the draft gave, for the matter it was for. */
    codeNames: (suggestion: ActivitySuggestion) =>
      draftForMatter(statusFor(suggestion), editFor(suggestion))?.codeNames ??
      [],
    /** The split or move on offer; see {@link draftStructure}. */
    structure: (suggestion: ActivitySuggestion) =>
      draftStructure(statusFor(suggestion), editFor(suggestion), suggestion),
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

  const submitBatch = (
    pending: PendingBatch,
    onSaved: (items: readonly BatchItem[]) => void,
  ) => {
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
        onSaved(pending.items);
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

type LearningStore = ReturnType<typeof useMatterLearning>;

type DayMattersOptions = {
  snapshot: ActivityDaySnapshot;
  /** The stored assignments with what the member included meanwhile. */
  manualAssignments: readonly ActivityManualAssignment[];
  draftedEntries: DraftedEntries;
  nowMs: number;
};
/** The day matched: against the shortlist plus each id a record, rule or
 * learned weight names, resolved under the member's access before anything
 * is suggested. */
function useDayMatters({
  snapshot,
  manualAssignments,
  draftedEntries,
  nowMs,
}: DayMattersOptions) {
  const timed = timedSegments(snapshot.segments);
  const learningStore = useMatterLearning();
  const learning =
    learningStore.state.type === "ready"
      ? learningStore.state.value
      : EMPTY_MATTER_LEARNING;
  const { candidates, refreshCandidates } = useMatterCandidates([
    ...recordedMatterIds(snapshot),
    ...suggestedMatterIds({
      evidence: timed.map((segment) =>
        segmentEvidence(segment, snapshot.captureDetails),
      ),
      learning,
      nowMs,
    }),
  ]);
  useForgetInaccessible({ candidates, learningStore });
  const matters = candidates.type === "ready" ? candidates.matters : [];
  const day = matchDay({
    segments: timed,
    candidates: matters,
    resolved: candidates.type === "ready" ? candidates.resolved : [],
    captureDetails: snapshot.captureDetails,
    manualAssignments,
    draftedEntries,
    learning,
    nowMs,
  });
  // Saved entries teach this computer their evidence (`learnFromConfirmation`).
  const learnFrom = (
    suggestion: ActivitySuggestion,
    items: readonly BatchItem[],
  ) =>
    learnFromConfirmation({
      learningStore,
      captureDetails: snapshot.captureDetails,
      suggestion,
      items,
    });
  return {
    day,
    matters,
    candidates,
    refreshCandidates,
    learningStore,
    learnFrom,
  };
}

type LearnFromConfirmationOptions = {
  learningStore: LearningStore;
  captureDetails: boolean;
  suggestion: ActivitySuggestion;
  /** The entries saved for the suggestion. */
  items: readonly BatchItem[];
};
/**
 * What the suggestion's time showed counts toward the matter its saved
 * entries were filed under, and against the suggested matter if that
 * differs: a split or a full move teaches the matter that holds all of it.
 * A partial move teaches nothing, because a move divides time by duration,
 * not by which window or document moved, so no piece of evidence is known
 * to belong to either matter.
 */
const learnFromConfirmation = ({
  learningStore,
  captureDetails,
  suggestion,
  items,
}: LearnFromConfirmationOptions) => {
  const [matterId, ...others] = new Set(
    items.map(({ entry }) => entry.matterId),
  );
  if (matterId === undefined || others.length > 0) {
    return;
  }
  learningStore.update((current) =>
    learn(current, {
      evidence: suggestion.segments.map((segment) =>
        segmentEvidence(segment, captureDetails),
      ),
      matterId,
      suggestedMatterId: suggestion.matter?.id ?? null,
      nowMs: Temporal.Now.instant().epochMilliseconds,
    }),
  );
};

/** Forgets learned weights for matters a read answered the member can no
 * longer open. Rules stay until the member removes them. */
function useForgetInaccessible({
  candidates,
  learningStore,
}: {
  candidates: CandidateState;
  learningStore: LearningStore;
}) {
  const { state, update } = learningStore;
  const known =
    state.type === "ready"
      ? new Set([
          ...state.value.learned.map(({ matterId }) => matterId),
          ...state.value.tallies.map(({ matterId }) => matterId),
        ])
      : new Set<string>();
  const forgotten =
    candidates.type === "ready"
      ? candidates.resolved
          .flatMap((resolution) =>
            resolution.type === "inaccessible" && known.has(resolution.id)
              ? [resolution.id]
              : [],
          )
          .sort()
          .join(" ")
      : "";
  useEffect(() => {
    if (forgotten === "") {
      return;
    }
    update((current) => forgetMatters(current, new Set(forgotten.split(" "))));
  }, [forgotten, update]);
}

/** The next rule to propose, and why learning is not working, if it is not. */
const MatterLearningNotice = ({
  learning: {
    learningStore: { state, saveFailed, update, retry },
  },
  day: { openMatters },
}: {
  learning: { learningStore: LearningStore };
  day: { openMatters: ReadonlyMap<string, DesktopTimeEntryMatterCandidate> };
}) => {
  const t = useTranslations("activity");
  const tOnboarding = useTranslations("onboarding");
  if (state.type === "failed") {
    return (
      <div
        role="alert"
        className="text-destructive flex items-center gap-2 text-sm"
      >
        {t("matterLearningFailed")}
        <Button size="sm" variant="ghost" onClick={retry}>
          {t("retry")}
        </Button>
      </div>
    );
  }
  if (saveFailed) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t("matterLearningSaveFailed")}
      </p>
    );
  }
  if (state.type !== "ready") {
    return null;
  }
  const proposal = ruleProposals(state.value).find(({ matterId }) =>
    openMatters.has(matterId),
  );
  const matter =
    proposal === undefined ? undefined : openMatters.get(proposal.matterId);
  if (proposal === undefined || matter === undefined) {
    return null;
  }
  return (
    <div
      role="status"
      className="bg-muted flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm"
    >
      <span className="min-w-0 flex-1 text-pretty">
        {t(
          proposal.field === "documentPath"
            ? "ruleProposalDocument"
            : "ruleProposalTitle",
          { value: proposal.value, matter: matter.name },
        )}
      </span>
      <Button
        size="sm"
        onClick={() =>
          update((current) =>
            acceptProposal(current, proposal, crypto.randomUUID()),
          )
        }
      >
        {t("ruleProposalAccept")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => update((current) => declineProposal(current, proposal))}
      >
        {tOnboarding("notNow")}
      </Button>
    </div>
  );
};

/** The shortlist, plus every matter id the day names outside it, resolved
 * under the member's own access as the day names it. */
function useMatterCandidates(recordedIds: readonly string[]) {
  const [candidates, setCandidates] = useState<CandidateState>({
    type: "loading",
  });
  const candidateRequest = useRef(0);
  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- react/exhaustive-deps cannot see compiler memoization, and this value is an effect dependency
  const refreshCandidates = useCallback(() => {
    const request = ++candidateRequest.current;
    invoke<DesktopMatterCandidatesResponse>("time_entry_candidates")
      .then(({ matters, timeMinimumUnitMinutes }) => {
        if (request === candidateRequest.current) {
          setCandidates({
            type: "ready",
            matters,
            timeMinimumUnitMinutes,
            resolved: [],
          });
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
  // One key per set of unanswered ids, so a day that names a new matter
  // asks once, and an answered day asks nothing.
  const unresolved =
    candidates.type === "ready"
      ? unresolvedMatterIds({
          ids: recordedIds,
          candidates: candidates.matters,
          resolved: candidates.resolved,
        }).join(" ")
      : "";
  useEffect(() => {
    if (unresolved === "") {
      return;
    }
    const request = candidateRequest.current;
    resolveMatters(
      unresolved.split(" "),
      async (ids) =>
        await invoke<DesktopMatterResolution[]>("time_entry_resolve_matters", {
          ids,
        }),
    )
      .then((resolved) => {
        if (request === candidateRequest.current) {
          setCandidates((current) =>
            current.type === "ready"
              ? {
                  ...current,
                  resolved: [...current.resolved, ...resolved],
                }
              : current,
          );
        }
        return undefined;
      })
      .catch(() => {
        if (request === candidateRequest.current) {
          setCandidates({ type: "failed" });
        }
      });
  }, [unresolved]);
  return { candidates, refreshCandidates };
}

/**
 * The member's own entries on the day, from every device and the web, for a
 * card to say what is already recorded on its matter elsewhere. They are
 * read again whenever the window comes back to the front, as after time was
 * logged on another computer. The calendar is keyed by day, so a read never
 * outlives its date.
 */
function useRecordedElsewhere(
  { date, today }: Pick<ActivityDaySnapshot, "date" | "today">,
  onReview: () => void,
) {
  const [dayEntries, setDayEntries] = useState<DayEntriesRead>({
    type: "loading",
  });
  const dayEntriesRequest = useRef(0);
  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- react/exhaustive-deps cannot see compiler memoization, and this value is an effect dependency
  const refresh = useCallback(() => {
    const request = ++dayEntriesRequest.current;
    invoke<DesktopDayEntriesResponse>("time_entry_day_entries", { date })
      .then(({ entries }) => {
        if (request === dayEntriesRequest.current) {
          setDayEntries({ type: "ready", entries });
        }
        return undefined;
      })
      .catch(() => {
        if (request === dayEntriesRequest.current) {
          setDayEntries({ type: "failed" });
        }
      });
  }, [date]);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      dayEntriesRequest.current += 1;
    };
  }, [refresh]);
  return {
    dayEntries,
    day: date === today ? "today" : "other",
    onReview,
    onRetry: refresh,
  } as const;
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
