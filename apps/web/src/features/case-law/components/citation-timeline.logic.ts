import {
  CITATION_TREATMENT_ORDER,
  totalCitations,
} from "@/features/case-law/citation-treatment";
import type {
  CitationTreatment,
  CitationTreatmentCounts,
  CitationYearCounts,
} from "@/features/case-law/citation-treatment";
import { decisionDateToIso } from "@/lib/decision-date";

/** A year with citations is never drawn flat, however large the peak. */
export const MIN_VISIBLE_HEIGHT = 1;

type ColumnSegment = {
  height: number;
  treatment: CitationTreatment;
  y: number;
};

type StackColumnSegmentsOptions = {
  /** The y the column stands on: the plot's baseline, in the same units. */
  baseline: number;
  columnHeight: number;
  counts: CitationYearCounts;
};

/**
 * One column's segments, stacked bottom-up in display order reversed so the
 * treatment that must not be missed (negative) sits on top where the eye
 * lands. Every present treatment gets at least `MIN_VISIBLE_HEIGHT`, and the
 * stack is exactly `max(columnHeight, present treatments)` tall: rounding and
 * the floor can overshoot, so the excess is taken back from the tallest
 * segments first, never below the floor. A year with more treatments than the
 * scale gives it pixels is the one case where the column stands taller than
 * asked, because the alternative is a treatment nobody can see.
 *
 * Shared by the strip and the timeline chart, so a year cannot stack one way
 * at a glance and another way when the reader opens it.
 */
export const stackColumnSegments = ({
  baseline,
  columnHeight,
  counts,
}: StackColumnSegmentsOptions): ColumnSegment[] => {
  const total = totalCitations(counts);
  const sized: { height: number; treatment: CitationTreatment }[] = [];
  for (const treatment of CITATION_TREATMENT_ORDER.toReversed()) {
    const count = counts[treatment];
    if (count === 0) {
      continue;
    }
    sized.push({
      height: Math.max(
        MIN_VISIBLE_HEIGHT,
        Math.round((count / total) * columnHeight),
      ),
      treatment,
    });
  }

  // The height the stack actually settles at. Below one pixel per present
  // treatment the excess could never be paid off — every segment would sit on
  // the floor with the loop unable to take anything back — and the stack
  // would overrun the column it was asked for.
  const stackHeight = Math.max(columnHeight, sized.length * MIN_VISIBLE_HEIGHT);

  let stacked = 0;
  for (const part of sized) {
    stacked += part.height;
  }
  let excess = stacked - stackHeight;
  while (excess > 0) {
    let tallest = sized.at(0);
    for (const part of sized) {
      if (tallest === undefined || part.height > tallest.height) {
        tallest = part;
      }
    }
    if (tallest === undefined || tallest.height <= MIN_VISIBLE_HEIGHT) {
      break;
    }
    tallest.height -= 1;
    excess -= 1;
  }

  const segments: ColumnSegment[] = [];
  let filled = 0;
  for (const part of sized) {
    segments.push({
      height: part.height,
      treatment: part.treatment,
      y: baseline - filled - part.height,
    });
    filled += part.height;
  }
  return segments;
};

/**
 * The treatments a set of counts actually holds, in display order: what a
 * legend, a breakdown and a tooltip each list, so the three agree.
 */
export const presentTreatments = (
  counts: CitationYearCounts | CitationTreatmentCounts,
): CitationTreatment[] =>
  CITATION_TREATMENT_ORDER.filter((treatment) => counts[treatment] > 0);

/** One calendar year of the span; `counts` is absent for a year nobody cited. */
export type TimelineColumn = {
  counts: CitationYearCounts | undefined;
  total: number;
  year: number;
};

type CitationTimelineColumnsOptions = {
  byYear: readonly CitationYearCounts[];
  /** First year drawn; earlier entries are dropped, later gaps filled. */
  fromYear: number;
  /** Last year drawn, inclusive. */
  toYear: number;
};

/**
 * Every year of the span, oldest first, including the silent ones: a gap is
 * as much of the reception as a peak, so it is drawn rather than skipped.
 */
export const citationTimelineColumns = ({
  byYear,
  fromYear,
  toYear,
}: CitationTimelineColumnsOptions): TimelineColumn[] => {
  const countsByYear = new Map(byYear.map((entry) => [entry.year, entry]));
  const columns: TimelineColumn[] = [];
  for (let year = fromYear; year <= toYear; year += 1) {
    const counts = countsByYear.get(year);
    columns.push({
      counts,
      total: counts === undefined ? 0 : totalCitations(counts),
      year,
    });
  }
  return columns;
};

/** The busiest year in view, and never zero: the bars scale against it. */
export const citationTimelinePeak = (
  columns: readonly TimelineColumn[],
): number => Math.max(1, ...columns.map((column) => column.total));

/** The busiest year, for the one count the chart labels directly. */
export const peakTimelineColumn = (
  columns: readonly TimelineColumn[],
): TimelineColumn | undefined => {
  let peak: TimelineColumn | undefined;
  for (const column of columns) {
    if (column.total > 0 && (peak === undefined || column.total > peak.total)) {
      peak = column;
    }
  }
  return peak;
};

export const lastNegativeYear = (
  byYear: readonly CitationYearCounts[],
): number | null => {
  let last: number | null = null;
  for (const entry of byYear) {
    if (entry.negative > 0 && (last === null || entry.year > last)) {
      last = entry.year;
    }
  }
  return last;
};

type CitingDecisionOrder = {
  decision: {
    /** The materialized weight search and the citator both rank by. */
    citationAuthority: number;
    decisionDate: Date | string | null;
  };
};

/**
 * The citing decisions to show first, flattened out of the per-treatment
 * leaders the citator lists: the most authoritative court first, and the
 * more recent decision where two carry the same weight. Undated decisions
 * sort last among their equals rather than jumping the queue.
 */
export const topCitingDecisions = <T extends CitingDecisionOrder>(
  rows: readonly T[],
  limit: number,
): T[] =>
  [...rows]
    .toSorted((a, b) => {
      const byAuthority =
        b.decision.citationAuthority - a.decision.citationAuthority;
      if (byAuthority !== 0) {
        return byAuthority;
      }
      // Compared as ISO days, where lexical order is chronological; an
      // undated decision has no day and falls to the end of its tier.
      const left = decisionDateToIso(a.decision.decisionDate) ?? "";
      const right = decisionDateToIso(b.decision.decisionDate) ?? "";
      if (left === right) {
        return 0;
      }
      return left < right ? 1 : -1;
    })
    .slice(0, limit);

type TimelineTickYearsOptions = {
  /** How many labels fit side by side without touching. */
  maxTicks: number;
  years: readonly number[];
};

/**
 * Which years carry an axis label. Both ends always, because they state the
 * span; the rest are evenly spaced and thinned to what fits, and an interior
 * tick crowding the last one is dropped rather than drawn over it.
 */
export const timelineTickYears = ({
  maxTicks,
  years,
}: TimelineTickYearsOptions): number[] => {
  const first = years.at(0);
  const last = years.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }
  if (first === last) {
    return [first];
  }
  if (maxTicks < 2) {
    return [last];
  }

  const step = Math.max(1, Math.ceil((years.length - 1) / (maxTicks - 1)));
  const ticks: number[] = [];
  for (let index = 0; index < years.length - 1; index += step) {
    const year = years.at(index);
    if (year !== undefined) {
      ticks.push(year);
    }
  }
  // The span's end outranks the last evenly spaced tick when the two would
  // collide: the reader reads the end of the timeline off it.
  if (years.length - 1 - (ticks.length - 1) * step < step / 2) {
    ticks.pop();
  }
  ticks.push(last);
  return ticks;
};
