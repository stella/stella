import { panic } from "better-result";

import type { DesktopTimeEntryMatterCandidate } from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";
import {
  DAY_CALENDAR_ONE_LINE_BLOCK_MIN_PX,
  DAY_CALENDAR_SLOT_HEIGHT_PX,
  granularityMs,
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
  leadingMatter,
  matterShare,
  withoutAppSuffix,
} from "./day-review-logic";
import type { DayReviewGroup, MatchedSegment } from "./day-review-logic";

const MINUTE_MS = 60_000;
/** Idle gaps up to this long keep one suggestion's time in one block. */
const SUGGESTION_RUN_GAP_MS = 5 * MINUTE_MS;

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

/** Pauses up to this long do not split one topic's block. */
export const TOPIC_BRIDGE_GAP_MS = 2 * MINUTE_MS;

/**
 * One topic's stretch of the day in the Activity column: a matter's time, or,
 * where nothing matched a matter, one document or window's time. The apps it
 * moved through are its details, not blocks of their own.
 */
export type ActivityBlock = DayCalendarRange & {
  apps: AppTotal[];
  /** Where the block is drawn to: at least one label line tall, so a brief
   * block can still be read, hovered and clicked, and never past the next
   * block's start. */
  drawnEndMs: number;
  id: string;
  matter: DesktopTimeEntryMatterCandidate | null;
  /** Every recorded segment in the block, in time order. */
  sources: MatchedSegment[];
  /** The title the block's topic spent longest on; `null` when its topic
   * recorded none, or the block has no topic. The block is named by the same
   * topic that sets its colour, never by another stretch it took in. */
  title: string | null;
  /** The topic holding at least half the block's recorded time: its matter,
   * call, document or window title, or app. `null` when no topic does, as in
   * quick switching between unrelated windows. */
  topic: string | null;
  /** The one app the topic was held in, and whether all of it was a call
   * there; `null` when the topic spans apps or the block has none. */
  topicApp: ActivityTopicApp | null;
};

type ActivityTopicApp = {
  appIdentifier: string;
  appName: string;
  call: boolean;
};

type TopicDraft = DayCalendarRange & {
  /** Recorded time in the stretch, pauses left out. */
  durationMs: number;
  matter: DesktopTimeEntryMatterCandidate | null;
  /** In time order: stretches only ever join their neighbours in time order. */
  sources: MatchedSegment[];
  topic: string;
};

/** Appends a later stretch to an earlier one, in place and without a sort; the
 * earlier one keeps its topic. */
const appendDraft = (earlier: TopicDraft, later: TopicDraft) => {
  for (const source of later.sources) {
    earlier.sources.push(source);
  }
  earlier.endMs = Math.max(earlier.endMs, later.endMs);
  earlier.durationMs += later.durationMs;
};

/** A later stretch takes in the earlier, short one before it and keeps its own
 * topic. */
const prependDraft = (later: TopicDraft, earlier: TopicDraft) => {
  later.sources = [...earlier.sources, ...later.sources];
  later.startMs = Math.min(later.startMs, earlier.startMs);
  later.durationMs += earlier.durationMs;
};

/** Neighbouring drafts of one topic, a pause apart at most, as one. */
const joinSameTopic = (drafts: readonly TopicDraft[]): TopicDraft[] => {
  const joined: TopicDraft[] = [];
  for (const draft of drafts) {
    const last = joined.at(-1);
    if (
      last !== undefined &&
      last.topic === draft.topic &&
      draft.startMs - last.endMs <= TOPIC_BRIDGE_GAP_MS
    ) {
      appendDraft(last, draft);
      continue;
    }
    joined.push(draft);
  }
  return joined;
};

/** The topic a stretch spent longest on. */
const dominantTopic = (
  sources: readonly MatchedSegment[],
  topicOf: (segment: MatchedSegment) => string,
): string => {
  const totals = new Map<string, number>();
  for (const segment of sources) {
    const topic = topicOf(segment);
    totals.set(
      topic,
      (totals.get(topic) ?? 0) + segment.endMs - segment.startMs,
    );
  }
  let topic = "";
  let longestMs = Number.NEGATIVE_INFINITY;
  for (const [candidate, durationMs] of totals) {
    if (durationMs > longestMs) {
      topic = candidate;
      longestMs = durationMs;
    }
  }
  return topic;
};

/**
 * Which neighbour a stretch too short for a label joins: one a pause apart at
 * most, of its own topic first, then one with no matter, then the longer.
 */
const preferredNeighbour = (
  draft: TopicDraft,
  before: TopicDraft | undefined,
  after: TopicDraft | undefined,
): "before" | "after" | null => {
  const rank = (other: TopicDraft | undefined, gapMs: number) =>
    other === undefined || gapMs > TOPIC_BRIDGE_GAP_MS
      ? null
      : (other.topic === draft.topic ? 4 : 0) +
        (other.matter === null ? 2 : 0) +
        other.durationMs / Number.MAX_SAFE_INTEGER;
  const beforeRank = rank(before, draft.startMs - (before?.endMs ?? 0));
  const afterRank = rank(
    after,
    (after?.startMs ?? Number.POSITIVE_INFINITY) - draft.endMs,
  );
  if (beforeRank === null && afterRank === null) {
    return null;
  }
  if (afterRank === null) {
    return "before";
  }
  return beforeRank === null || afterRank > beforeRank ? "after" : "before";
};

/**
 * The Activity column, one block per topic: consecutive time on one matter is
 * one block whatever apps it moved through, and time no matter claimed groups
 * by the document or window title it was on. A stretch too short to hold a
 * label line joins its neighbour unless it is a matter's own time, and
 * brief stretches with no matter less than a label line apart are one, so
 * quick switching never draws slivers and a matter's time always shows. A
 * pause is
 * time with nothing recorded: one of up to {@link TOPIC_BRIDGE_GAP_MS} does
 * not split a block, so a matter's time around a quick look at another app is
 * one block as long as each pause on either side of that look is short. Every
 * segment lands in exactly one block.
 */
export const activityBlocks = (
  segments: readonly MatchedSegment[],
  granularity: DayCalendarGranularity,
): ActivityBlock[] => {
  const titleOf = segmentTitles(segments);
  const topicOf = (segment: MatchedSegment) => {
    if (segment.matter !== null) {
      return `matter:${segment.matter.id}`;
    }
    if (segment.call) {
      return `call:${segment.appIdentifier}`;
    }
    const title = titleOf(segment);
    return title === null
      ? `app:${segment.appIdentifier}`
      : `title:${title.toLocaleLowerCase()}`;
  };
  const thresholdMs = shortSegmentThresholdMs(granularity);
  const isLoose = (draft: TopicDraft) =>
    draft.matter === null && draft.endMs - draft.startMs < thresholdMs;
  // A copy sorted in place: older WebViews lack `toSorted`.
  const drafts = joinSameTopic(
    [...segments]
      .sort(
        (left, right) =>
          left.startMs - right.startMs || left.endMs - right.endMs,
      )
      .map((segment) => ({
        durationMs: segment.endMs - segment.startMs,
        endMs: segment.endMs,
        matter: segment.matter,
        sources: [segment],
        startMs: segment.startMs,
        topic: topicOf(segment),
      })),
  );
  // Quick switching: stretches with no matter, each too short for a label and
  // less than a label line apart, are one stretch named by the topic it spent
  // longest on.
  const runs: { draft: TopicDraft; loose: boolean; merged: boolean }[] = [];
  for (const draft of drafts) {
    const last = runs.at(-1);
    const loose = isLoose(draft);
    if (
      loose &&
      last?.loose === true &&
      draft.startMs - last.draft.endMs <= thresholdMs
    ) {
      appendDraft(last.draft, draft);
      last.merged = true;
      continue;
    }
    runs.push({ draft, loose, merged: false });
  }
  for (const run of runs) {
    if (run.merged) {
      run.draft.topic = dominantTopic(run.draft.sources, topicOf);
    }
  }
  // A stretch still too short for a label joins a neighbour a pause apart at
  // most; one left alone is drawn a label line tall where there is room.
  const placed: TopicDraft[] = [];
  let carried: TopicDraft | null = null;
  for (const [index, run] of runs.entries()) {
    const { draft } = run;
    if (carried !== null) {
      prependDraft(draft, carried);
      carried = null;
    }
    if (!run.loose || !isLoose(draft)) {
      placed.push(draft);
      continue;
    }
    const before = placed.at(-1);
    const side = preferredNeighbour(draft, before, runs[index + 1]?.draft);
    switch (side) {
      case "before":
        if (before === undefined) {
          return panic("A short activity stretch has no earlier neighbour");
        }
        appendDraft(before, draft);
        break;
      case "after":
        carried = draft;
        break;
      case null:
        placed.push(draft);
        break;
      default:
        side satisfies never;
        return panic("Unhandled activity neighbour");
    }
  }
  const blocks = joinSameTopic(placed);
  return blocks.map((draft, index) => {
    const topic = majorityTopic(draft, topicOf);
    const topicSources =
      topic === null
        ? []
        : draft.sources.filter((segment) => topicOf(segment) === topic);
    const titleTotals = new Map<string, number>();
    for (const segment of topicSources) {
      const title = titleOf(segment);
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
    const first = draft.sources.at(0);
    const nextStartMs = blocks[index + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    return {
      apps: appTotals(draft.sources),
      drawnEndMs: Math.min(
        Math.max(draft.endMs, draft.startMs + thresholdMs),
        Math.max(draft.endMs, nextStartMs),
      ),
      endMs: draft.endMs,
      id:
        first === undefined
          ? draft.topic
          : `${draft.topic}:${String(first.startMs)}:${first.appIdentifier}`,
      matter: draft.matter,
      sources: draft.sources,
      startMs: draft.startMs,
      title,
      topic,
      topicApp: topicAppOf(topicSources),
    };
  });
};

/** The app a topic's segments were all in, if one. */
const topicAppOf = (
  topicSources: readonly MatchedSegment[],
): ActivityTopicApp | null => {
  const first = topicSources.at(0);
  if (
    first === undefined ||
    topicSources.some(
      ({ appIdentifier }) => appIdentifier !== first.appIdentifier,
    )
  ) {
    return null;
  }
  return {
    appIdentifier: first.appIdentifier,
    appName: first.appName,
    call: topicSources.every(({ call }) => call),
  };
};

/** Whether a part holds at least half of some recorded time: the one rule
 * that names an Activity block's topic and presets a selected range's
 * matter. */
const holdsMajority = (partMs: number, recordedMs: number) =>
  partMs * 2 >= recordedMs;

/** The topic holding at least half a stretch's recorded time, if any. */
const majorityTopic = (
  draft: TopicDraft,
  topicOf: (segment: MatchedSegment) => string,
): string | null => {
  if (draft.matter !== null) {
    return `matter:${draft.matter.id}`;
  }
  const topic = dominantTopic(draft.sources, topicOf);
  let topicMs = 0;
  for (const segment of draft.sources) {
    if (topicOf(segment) === topic) {
      topicMs += segment.endMs - segment.startMs;
    }
  }
  return holdsMajority(topicMs, draft.durationMs) ? topic : null;
};

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

/**
 * Why a selected range starts on the matter it does: one matter holds at
 * least half its recorded time; or none does, because most of that time
 * belongs to no matter or because it is split between matters; or nothing
 * was recorded in it.
 */
export type RangeMatterBasis =
  "majority" | "mostlyUnmatched" | "splitBetweenMatters" | "nothingRecorded";

export type ActivitySuggestion = DayReviewGroup & {
  endMs: number;
  runs: DayCalendarRange[];
  startMs: number;
} & ({ type: "matched" } | { matterBasis: RangeMatterBasis; type: "manual" });

const toSuggestion = (group: DayReviewGroup): ActivitySuggestion => {
  const runs = contiguousRuns(group.segments);
  return {
    ...group,
    endMs: runs.at(-1)?.endMs ?? 0,
    runs,
    startMs: runs.at(0)?.startMs ?? 0,
    type: "matched",
  };
};

/** Every matched group not yet drafted and not left out, in day order. */
export const matchedSuggestions = (
  groups: readonly DayReviewGroup[],
  leftOut: ReadonlySet<string>,
): ActivitySuggestion[] =>
  groups
    .filter((group) => group.matter !== null && !leftOut.has(group.id))
    .map(toSuggestion)
    .sort((left, right) => left.startMs - right.startMs);

/** The parts of `range` no drafted entry covers, in time order; an empty or
 * backwards range has none. */
export const undraftedParts = (
  range: DayCalendarRange,
  drafted: readonly DayCalendarRange[],
): DayCalendarRange[] => {
  const parts: DayCalendarRange[] = [];
  let cursorMs = range.startMs;
  for (const taken of [...drafted].sort(
    (left, right) => left.startMs - right.startMs,
  )) {
    if (
      taken.endMs <= taken.startMs ||
      taken.endMs <= cursorMs ||
      taken.startMs >= range.endMs
    ) {
      continue;
    }
    if (taken.startMs > cursorMs) {
      parts.push({ endMs: taken.startMs, startMs: cursorMs });
    }
    cursorMs = taken.endMs;
  }
  if (cursorMs < range.endMs) {
    parts.push({ endMs: range.endMs, startMs: cursorMs });
  }
  return parts;
};

type ManualSuggestionOptions = {
  /** Stays the same while the user moves the range, so the card keeps what
   * was typed into it. */
  id: string;
  range: DayCalendarRange;
  segments: readonly MatchedSegment[];
  /** Ranges entries already cover; a new entry never claims them again. */
  drafted: readonly { start: string; end: string }[];
};

/**
 * An entry for exactly the range the user selected, less any time an entry
 * already covers: the range is the claim, whether or not activity was
 * recorded in it. The recorded time inside it is the evidence. A matter is
 * the starting choice only when it holds at least half that time, the rule
 * that names Activity blocks; a minority matter never claims the range.
 */
export const manualSuggestion = ({
  id,
  range,
  segments,
  drafted,
}: ManualSuggestionOptions): Extract<
  ActivitySuggestion,
  { type: "manual" }
> => {
  const parts = undraftedParts(
    range,
    drafted.map(({ start, end }) => ({
      endMs: Temporal.Instant.from(end).epochMilliseconds,
      startMs: Temporal.Instant.from(start).epochMilliseconds,
    })),
  );
  const clipped = segments.flatMap((segment) =>
    parts.flatMap((part) => {
      const startMs = Math.max(segment.startMs, part.startMs);
      const endMs = Math.min(segment.endMs, part.endMs);
      return endMs > startMs ? [{ ...segment, endMs, startMs }] : [];
    }),
  );
  const { basis, matter } = rangeMatter(clipped);
  const durationMs = parts.reduce(
    (sum, part) => sum + part.endMs - part.startMs,
    0,
  );
  return {
    apps: appTotals(clipped),
    confidence: "manual",
    durationMs,
    // The card and the selection show the range as the user set it.
    endMs: Math.max(range.startMs, range.endMs),
    evidence: appEvidence(clipped),
    id,
    matter,
    matterBasis: basis,
    ranges: parts.map(({ startMs, endMs }) => ({
      start: Temporal.Instant.fromEpochMilliseconds(startMs).toString(),
      end: Temporal.Instant.fromEpochMilliseconds(endMs).toString(),
    })),
    roundedTenths: roundedTenthsOfHour(durationMs),
    runs: parts,
    segments: clipped,
    startMs: range.startMs,
    type: "manual",
  };
};

/** The matter a selected range starts on, and why. */
const rangeMatter = (
  segments: readonly MatchedSegment[],
): {
  basis: RangeMatterBasis;
  matter: DesktopTimeEntryMatterCandidate | null;
} => {
  const recordedMs = totalDurationMs(segments);
  if (recordedMs === 0) {
    return { basis: "nothingRecorded", matter: null };
  }
  const { leading, unmatchedMs } = matterShare(segments);
  if (leading !== null && holdsMajority(leading.durationMs, recordedMs)) {
    return { basis: "majority", matter: leading.matter };
  }
  return {
    basis:
      unmatchedMs * 2 > recordedMs ? "mostlyUnmatched" : "splitBetweenMatters",
    matter: null,
  };
};

export type RangeEdge = "end" | "start";

/** A wall-clock time to the minute. */
type WallClock = { hour: number; minute: number };

/** The `HH:mm` wall-clock time an instant shows in `timeZone`. */
export const wallClockTime = (ms: number, timeZone: string): string =>
  Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timeZone)
    .toPlainTime()
    .toString({ smallestUnit: "minute" });

type MovedEdgeOptions = {
  /** The calendar day, `YYYY-MM-DD`, both edges stay on. */
  date: string;
  edge: RangeEdge;
  range: DayCalendarRange;
  time: WallClock;
  timeZone: string;
};

/**
 * The range with one edge set to a wall-clock time on `date`. A new start
 * moves the range and keeps its length, as far as the day allows; a new end
 * resizes it and may land at or before the start, which the card reports
 * rather than corrects. An end at midnight is the day's end, the only
 * midnight after a start on the same day. A time a daylight-saving change
 * skips resolves forward, as clocks read once it has passed.
 */
export const withMovedEdge = ({
  date,
  edge,
  range,
  time,
  timeZone,
}: MovedEdgeOptions): DayCalendarRange => {
  const day = Temporal.PlainDate.from(date);
  const dayEndMs = day
    .add({ days: 1 })
    .toZonedDateTime({ timeZone }).epochMilliseconds;
  const atMs = day.toZonedDateTime({
    plainTime: Temporal.PlainTime.from(time),
    timeZone,
  }).epochMilliseconds;
  switch (edge) {
    case "start": {
      const lengthMs = Math.max(0, range.endMs - range.startMs);
      return { endMs: Math.min(atMs + lengthMs, dayEndMs), startMs: atMs };
    }
    case "end":
      return {
        endMs: time.hour === 0 && time.minute === 0 ? dayEndMs : atMs,
        startMs: range.startMs,
      };
    default:
      edge satisfies never;
      return panic("Unhandled range edge");
  }
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

export type EvidenceRow = {
  /** The app the row's time was recorded in; it picks the row's icon. */
  appIdentifier: string;
  durationMs: number;
  id: string;
  label: string;
  /** The matter holding most of the row's time, if any. */
  matter: DesktopTimeEntryMatterCandidate | null;
  /** Share of the suggestion's time, 0 to 1. */
  share: number;
};

/** The Titles tab: every title across the suggestion's apps. */
export const titleRows = (suggestion: ActivitySuggestion): EvidenceRow[] =>
  suggestion.evidence
    .flatMap(({ identifier, details }) =>
      details.map(({ title, durationMs, matter }) => ({
        appIdentifier: identifier,
        durationMs,
        id: `${identifier}:${title}`,
        label: title,
        matter,
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
    appIdentifier: identifier,
    durationMs,
    id: identifier,
    label: name,
    matter: leadingMatter(
      suggestion.segments.filter(
        ({ appIdentifier }) => appIdentifier === identifier,
      ),
    ),
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
