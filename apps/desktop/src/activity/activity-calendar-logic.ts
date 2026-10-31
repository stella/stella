import { panic } from "better-result";

import type { DesktopTimeEntryMatterCandidate } from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";
import {
  DAY_CALENDAR_ONE_LINE_BLOCK_MIN_PX,
  DAY_CALENDAR_SLOT_HEIGHT_PX,
  granularityMs,
  mergeShortSegments,
} from "@stll/ui/day-calendar.logic";
import type {
  DayCalendarGranularity,
  DayCalendarRange,
} from "@stll/ui/day-calendar.logic";

import {
  appTotals,
  roundedTenthsOfHour,
  totalDurationMs,
} from "./activity-logic";
import type { AppTotal } from "./activity-logic";
import {
  appEvidence,
  cleanSharedContext,
  withoutAppSuffix,
} from "./day-review-logic";
import type { DayReviewGroup, MatchedSegment } from "./day-review-logic";

const MINUTE_MS = 60_000;
/** Idle gaps up to this long keep one suggestion's time in one block. */
const SUGGESTION_RUN_GAP_MS = 5 * MINUTE_MS;
/** Titles one stella AI description may send; the native side refuses more. */
export const NARRATIVE_TITLE_LIMIT = 40;
/** Consecutive declines after which the consent strip folds into a button. */
export const NARRATIVE_DECLINES_BEFORE_FOLD = 3;

/** Working hours the calendar always shows. */
const DEFAULT_HOURS = { endHour: 18, startHour: 8 } as const;

type CalendarHoursOptions = {
  date: string;
  instants: readonly number[];
  timeZone: string;
};

/** Whole wall-clock hours that cover the working day and every instant on
 * `date`; instants on other days stretch the view to that edge. */
export const calendarHours = ({
  date,
  instants,
  timeZone,
}: CalendarHoursOptions) => {
  const day = Temporal.PlainDate.from(date);
  let startHour: number = DEFAULT_HOURS.startHour;
  let endHour: number = DEFAULT_HOURS.endHour;
  for (const ms of instants) {
    const zoned =
      Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone);
    startHour = Math.min(startHour, hourOnDay(zoned, day, "floor"));
    endHour = Math.max(endHour, hourOnDay(zoned, day, "ceil"));
  }
  return { endHour, startHour };
};

/** The wall-clock hour an instant falls in on `day`, rounded to a whole hour;
 * before the day is 0 and after it is 24. */
function hourOnDay(
  zoned: Temporal.ZonedDateTime,
  day: Temporal.PlainDate,
  rounding: "ceil" | "floor",
) {
  const order = Temporal.PlainDate.compare(zoned.toPlainDate(), day);
  if (order < 0) {
    return 0;
  }
  if (order > 0) {
    return 24;
  }
  const partial = zoned.minute > 0 || zoned.second > 0 || zoned.millisecond > 0;
  return rounding === "ceil" && partial ? zoned.hour + 1 : zoned.hour;
}

/** A segment drawn shorter than one line cannot hold its own label. */
export const shortSegmentThresholdMs = (granularity: DayCalendarGranularity) =>
  (granularityMs(granularity) * DAY_CALENDAR_ONE_LINE_BLOCK_MIN_PX) /
  DAY_CALENDAR_SLOT_HEIGHT_PX[granularity];

export type ActivityBlock =
  | (DayCalendarRange & { id: string; segment: MatchedSegment; type: "single" })
  | (DayCalendarRange & {
      apps: AppTotal[];
      id: string;
      sources: MatchedSegment[];
      type: "mixed";
    });

/** The Activity column: each recorded segment, with runs of rapid switching
 * merged into one block that lists its apps, longest first. */
export const activityBlocks = (
  segments: readonly MatchedSegment[],
  granularity: DayCalendarGranularity,
): ActivityBlock[] =>
  mergeShortSegments(
    segments.map((segment) => ({
      ...segment,
      id: `${String(segment.startMs)}:${segment.appIdentifier}`,
    })),
    { thresholdMs: shortSegmentThresholdMs(granularity) },
  ).map((merged) => {
    switch (merged.type) {
      case "single":
        return {
          endMs: merged.segment.endMs,
          id: merged.segment.id,
          segment: merged.segment,
          startMs: merged.segment.startMs,
          type: "single",
        };
      case "mixed":
        return {
          apps: appTotals(merged.sources),
          endMs: merged.endMs,
          id: merged.id,
          sources: merged.sources,
          startMs: merged.startMs,
          type: "mixed",
        };
      default:
        merged satisfies never;
        return panic("Unhandled merged activity segment");
    }
  });

const rawSegmentTitle = (segment: MatchedSegment) => {
  // Evidence lists the document name before the window title.
  const detail = segment.evidence.at(0);
  return detail === undefined
    ? null
    : withoutAppSuffix(detail, segment.appName).trim();
};

/** What each segment block names, keyed by segment start: its document or
 * window title without the app's suffix or the context its app's titles
 * share; `null` when nothing beyond the app name was recorded. */
export const segmentTitles = (segments: readonly MatchedSegment[]) => {
  const byApp = new Map<string, Set<string>>();
  for (const segment of segments) {
    const title = rawSegmentTitle(segment);
    if (title) {
      const titles = byApp.get(segment.appIdentifier) ?? new Set();
      titles.add(title);
      byApp.set(segment.appIdentifier, titles);
    }
  }
  const cleaned = new Map(
    [...byApp].map(([app, titles]) => [app, cleanSharedContext([...titles])]),
  );
  return (segment: MatchedSegment) => {
    const raw = rawSegmentTitle(segment);
    if (!raw) {
      return null;
    }
    const title = cleaned.get(segment.appIdentifier)?.get(raw) ?? raw;
    return title.toLowerCase() === segment.appName.toLowerCase() ? null : title;
  };
};

/** Apps a block's hover lists before it only counts the rest. */
export const BLOCK_DETAIL_APP_LIMIT = 5;

export type BlockDetailRow = AppTotal & { title: string | null };

/** What an Activity block's hover lists: its apps, longest first, each with
 * the title it spent longest on, and how many apps past the limit it leaves
 * out. */
export const blockDetails = (
  sources: readonly MatchedSegment[],
  titleOf: (segment: MatchedSegment) => string | null,
): { hiddenCount: number; rows: BlockDetailRow[] } => {
  const rows = appTotals(sources).map((app) => {
    const titleTotals = new Map<string, number>();
    for (const segment of sources) {
      const title =
        segment.appIdentifier === app.identifier ? titleOf(segment) : null;
      if (title !== null) {
        titleTotals.set(
          title,
          (titleTotals.get(title) ?? 0) + segment.endMs - segment.startMs,
        );
      }
    }
    let title: string | null = null;
    let longestMs = 0;
    for (const [candidate, durationMs] of titleTotals) {
      if (durationMs > longestMs) {
        title = candidate;
        longestMs = durationMs;
      }
    }
    return { ...app, title };
  });
  return {
    hiddenCount: Math.max(0, rows.length - BLOCK_DETAIL_APP_LIMIT),
    rows: rows.slice(0, BLOCK_DETAIL_APP_LIMIT),
  };
};

/** Contiguous stretches of a suggestion's time; short idle gaps do not split
 * a stretch. */
export const contiguousRuns = (
  segments: readonly DayCalendarRange[],
): DayCalendarRange[] => {
  const runs: DayCalendarRange[] = [];
  for (const segment of [...segments].sort(
    (left, right) => left.startMs - right.startMs,
  )) {
    const last = runs.at(-1);
    if (last && segment.startMs - last.endMs <= SUGGESTION_RUN_GAP_MS) {
      last.endMs = Math.max(last.endMs, segment.endMs);
      continue;
    }
    runs.push({ endMs: segment.endMs, startMs: segment.startMs });
  }
  return runs;
};

export type ActivitySuggestion = DayReviewGroup & {
  endMs: number;
  runs: DayCalendarRange[];
  startMs: number;
  type: "matched" | "manual";
};

const toSuggestion = (
  group: DayReviewGroup,
  type: ActivitySuggestion["type"],
): ActivitySuggestion => {
  const runs = contiguousRuns(group.segments);
  return {
    ...group,
    endMs: runs.at(-1)?.endMs ?? 0,
    runs,
    startMs: runs.at(0)?.startMs ?? 0,
    type,
  };
};

/** Every matched group not yet drafted and not left out, in day order. */
export const matchedSuggestions = (
  groups: readonly DayReviewGroup[],
  leftOut: ReadonlySet<string>,
): ActivitySuggestion[] =>
  groups
    .filter((group) => group.matter !== null && !leftOut.has(group.id))
    .map((group) => toSuggestion(group, "matched"))
    .sort((left, right) => left.startMs - right.startMs);

/** The undrafted recorded time inside a range the user selected, with the
 * matter that took most of it as a starting choice. */
export const manualSuggestion = (
  segments: readonly MatchedSegment[],
  range: DayCalendarRange,
): ActivitySuggestion => {
  const clipped = segments.flatMap((segment) => {
    const startMs = Math.max(segment.startMs, range.startMs);
    const endMs = Math.min(segment.endMs, range.endMs);
    return !segment.drafted && endMs > startMs
      ? [{ ...segment, endMs, startMs }]
      : [];
  });
  const matterTime = new Map<
    string,
    { durationMs: number; matter: DesktopTimeEntryMatterCandidate }
  >();
  for (const segment of clipped) {
    if (!segment.matter) {
      continue;
    }
    const existing = matterTime.get(segment.matter.id);
    matterTime.set(segment.matter.id, {
      durationMs: (existing?.durationMs ?? 0) + segment.endMs - segment.startMs,
      matter: segment.matter,
    });
  }
  const matter =
    [...matterTime.values()]
      .sort(
        (left, right) =>
          right.durationMs - left.durationMs ||
          left.matter.id.localeCompare(right.matter.id),
      )
      .at(0)?.matter ?? null;
  const durationMs = totalDurationMs(clipped);
  const suggestion = toSuggestion(
    {
      apps: appTotals(clipped),
      confidence: "manual",
      durationMs,
      evidence: appEvidence(clipped),
      id: `manual:${String(range.startMs)}:${String(range.endMs)}`,
      matter,
      ranges: clipped.map(({ startMs, endMs }) => ({
        start: Temporal.Instant.fromEpochMilliseconds(startMs).toString(),
        end: Temporal.Instant.fromEpochMilliseconds(endMs).toString(),
      })),
      roundedTenths: roundedTenthsOfHour(durationMs),
      segments: clipped,
    },
    "manual",
  );
  // An empty range still anchors its card at the selection.
  return clipped.length > 0
    ? suggestion
    : { ...suggestion, endMs: range.endMs, startMs: range.startMs };
};

/** The suggestion to triage next: the first one after `afterMs`, else the
 * day's first. */
export const nextSuggestion = (
  suggestions: readonly ActivitySuggestion[],
  { afterMs, excludeId }: { afterMs: number; excludeId: string },
) => {
  const remaining = suggestions.filter(({ id }) => id !== excludeId);
  return (
    remaining.find(({ startMs }) => startMs >= afterMs) ??
    remaining.at(0) ??
    null
  );
};

/** The window titles a stella AI description may use, longest-used first. */
export const narrativeTitles = (suggestion: ActivitySuggestion) =>
  [
    ...new Set(
      suggestion.evidence
        .flatMap(({ details }) => details)
        .sort((left, right) => right.durationMs - left.durationMs)
        .map(({ title }) => title),
    ),
  ].slice(0, NARRATIVE_TITLE_LIMIT);

export type EvidenceRow = {
  durationMs: number;
  id: string;
  label: string;
  /** Share of the suggestion's time, 0 to 1. */
  share: number;
};

/** The Titles tab: every title across the suggestion's apps. */
export const titleRows = (suggestion: ActivitySuggestion): EvidenceRow[] =>
  suggestion.evidence
    .flatMap(({ identifier, details }) =>
      details.map(({ title, durationMs }) => ({
        durationMs,
        id: `${identifier}:${title}`,
        label: title,
        share: shareOf(durationMs, suggestion.durationMs),
      })),
    )
    .sort(
      (left, right) =>
        right.durationMs - left.durationMs ||
        left.label.localeCompare(right.label),
    );

/** The Apps tab: each app's time in the suggestion. */
export const appRows = (suggestion: ActivitySuggestion): EvidenceRow[] =>
  suggestion.apps.map(({ identifier, name, durationMs }) => ({
    durationMs,
    id: identifier,
    label: name,
    share: shareOf(durationMs, suggestion.durationMs),
  }));

function shareOf(durationMs: number, totalMs: number) {
  return totalMs > 0 ? Math.min(1, durationMs / totalMs) : 0;
}

type DraftedBlock = DayCalendarRange & {
  entryId: string;
  matter: DesktopTimeEntryMatterCandidate | null;
};

/** Created drafts in the Time entries column: one block per contiguous
 * stretch of each entry, named after the matter its time was matched to. */
export const draftedBlocks = (
  draftedEntries: readonly { start: string; end: string; entryId: string }[],
  segments: readonly MatchedSegment[],
): DraftedBlock[] => {
  const byEntry = new Map<string, DayCalendarRange[]>();
  for (const { start, end, entryId } of draftedEntries) {
    const ranges = byEntry.get(entryId) ?? [];
    ranges.push({
      endMs: Temporal.Instant.from(end).epochMilliseconds,
      startMs: Temporal.Instant.from(start).epochMilliseconds,
    });
    byEntry.set(entryId, ranges);
  }
  return [...byEntry].flatMap(([entryId, ranges]) => {
    const matter =
      segments.find(
        (segment) =>
          segment.matter !== null &&
          ranges.some(
            ({ startMs, endMs }) =>
              segment.startMs >= startMs && segment.endMs <= endMs,
          ),
      )?.matter ?? null;
    return contiguousRuns(ranges).map((run) => ({ ...run, entryId, matter }));
  });
};
