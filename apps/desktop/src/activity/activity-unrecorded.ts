import { Temporal } from "@stll/time";

import type { TimedSegment } from "./activity-logic";
import type { OutageRange } from "./activity-outages";
import type {
  ActivityGap,
  ActivityGapDisplay,
  ActivityGapEnd,
} from "./activity-types";

/** A stretch with no input. `after` is the recorded segment that ended
 * where it began, which names it; a gap itself holds no content. */
type GapRange<S extends TimedSegment> = {
  after: S | null;
  display: ActivityGapDisplay;
  endMs: number;
  endedBy: ActivityGapEnd;
  startMs: number;
};

/** Every kind of time the day shows as not recorded: time Activity could
 * not record, and time with no input between recorded activity. */
export type UnrecordedRange<S extends TimedSegment> =
  ({ type: "outage" } & OutageRange) | ({ type: "gap" } & GapRange<S>);

/** The day's gaps in order, each with the segment it followed. */
const gapRanges = <S extends TimedSegment>(
  gaps: readonly ActivityGap[],
  segments: readonly S[],
): GapRange<S>[] => {
  const endingAt = new Map(segments.map((segment) => [segment.endMs, segment]));
  return gaps
    .map(({ start, end, endedBy, display }) => {
      const startMs = Temporal.Instant.from(start).epochMilliseconds;
      return {
        after: endingAt.get(startMs) ?? null,
        display,
        endMs: Temporal.Instant.from(end).epochMilliseconds,
        endedBy,
        startMs,
      };
    })
    .filter(({ endMs, startMs }) => endMs > startMs)
    .sort((left, right) => left.startMs - right.startMs);
};

/** Outages and gaps as one list: the calendar draws both the same way. */
export const unrecordedRanges = <S extends TimedSegment>(
  outages: readonly OutageRange[],
  gaps: readonly ActivityGap[],
  segments: readonly S[],
): UnrecordedRange<S>[] => [
  ...outages.map((outage) => ({ type: "outage" as const, ...outage })),
  ...gapRanges(gaps, segments).map((gap) => ({ type: "gap" as const, ...gap })),
];

/** The sentence naming what the screen did during a gap. */
export const GAP_DISPLAY_KEYS = {
  stayedOn: "gapDisplay.stayedOn",
  locked: "gapDisplay.locked",
  slept: "gapDisplay.slept",
} as const satisfies Record<ActivityGapDisplay, string>;

/** The sentence naming what ended a gap. */
export const GAP_END_KEYS = {
  input: "gapEnd.input",
  stop: "gapEnd.stop",
  dayEnd: "gapEnd.dayEnd",
} as const satisfies Record<ActivityGapEnd, string>;
