import { useTranslations } from "use-intl";

import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import {
  CITATION_TREATMENT_FILL,
  CITATION_TREATMENT_LABEL,
  CITATION_TREATMENT_ORDER,
  totalCitations,
} from "@/features/case-law/citation-treatment";
import type {
  CitationTreatment,
  CitationYearCounts,
} from "@/features/case-law/citation-treatment";

const STRIP_HEIGHT = 16;
const COLUMN_WIDTH = 5;
const COLUMN_GAP = 1;
/** A year with citations is never drawn flat, however large the peak. */
const MIN_VISIBLE_HEIGHT = 1;

type CitationYearStripProps = {
  byYear: readonly CitationYearCounts[];
  className?: string | undefined;
  /** First year drawn; earlier entries are dropped, later gaps filled. */
  fromYear: number;
  /** Last year drawn, inclusive. */
  toYear: number;
};

/**
 * One column per calendar year of incoming citations, stacked by treatment.
 *
 * No axes and no labels: the strip is a glance at the shape of a decision's
 * reception, the counts are a hover away. Height scales to the busiest year
 * in view, so two strips are not comparable by eye; that is the reader's
 * own decision against its own past, which is the question asked of it.
 */
type ColumnSegment = {
  height: number;
  treatment: CitationTreatment;
  y: number;
};

type StackColumnSegmentsOptions = {
  columnHeight: number;
  counts: CitationYearCounts;
};

/**
 * One column's segments, stacked bottom-up in display order reversed so the
 * treatment that must not be missed (negative) sits on top where the eye
 * lands. Every present treatment gets at least `MIN_VISIBLE_HEIGHT`, and the
 * stack never exceeds `columnHeight`: rounding and the floor can overshoot,
 * so the excess is taken back from the tallest segments first, never below
 * the floor, which keeps the top edge inside the strip.
 */
export const stackColumnSegments = ({
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

  let stacked = 0;
  for (const part of sized) {
    stacked += part.height;
  }
  let excess = stacked - columnHeight;
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
      y: STRIP_HEIGHT - filled - part.height,
    });
    filled += part.height;
  }
  return segments;
};

export const CitationYearStrip = ({
  byYear,
  className,
  fromYear,
  toYear,
}: CitationYearStripProps) => {
  const t = useTranslations();

  if (toYear < fromYear) {
    return null;
  }

  const countsByYear = new Map(byYear.map((entry) => [entry.year, entry]));
  const years: number[] = [];
  for (let year = fromYear; year <= toYear; year += 1) {
    years.push(year);
  }
  const peak = Math.max(
    1,
    ...years.map((year) => {
      const counts = countsByYear.get(year);
      return counts === undefined ? 0 : totalCitations(counts);
    }),
  );
  const width = years.length * (COLUMN_WIDTH + COLUMN_GAP) - COLUMN_GAP;

  return (
    <svg
      aria-label={t("caseLaw.citation.stripLabel")}
      className={cn("block shrink-0 overflow-visible", className)}
      height={STRIP_HEIGHT}
      role="img"
      viewBox={`0 0 ${String(width)} ${String(STRIP_HEIGHT)}`}
      width={width}
    >
      {years.map((year, index) => {
        const counts = countsByYear.get(year);
        const x = index * (COLUMN_WIDTH + COLUMN_GAP);
        if (counts === undefined) {
          return (
            <rect
              className="fill-border"
              height={MIN_VISIBLE_HEIGHT}
              key={year}
              width={COLUMN_WIDTH}
              x={x}
              y={STRIP_HEIGHT - MIN_VISIBLE_HEIGHT}
            />
          );
        }

        const total = totalCitations(counts);
        const columnHeight = Math.max(
          MIN_VISIBLE_HEIGHT,
          Math.round((total / peak) * STRIP_HEIGHT),
        );
        const segments = stackColumnSegments({ columnHeight, counts });

        const breakdown = CITATION_TREATMENT_ORDER.filter(
          (treatment) => counts[treatment] > 0,
        )
          .map(
            (treatment) =>
              `${t(CITATION_TREATMENT_LABEL[treatment])} ${String(counts[treatment])}`,
          )
          .join(" · ");

        return (
          <Tooltip key={year}>
            {/* A group is not focusable by itself; the tab stop and label
                give keyboard and screen-reader users the same per-year
                breakdown the tooltip shows on hover. */}
            <TooltipTrigger
              render={
                <g
                  aria-label={`${t("caseLaw.citation.yearTitle", {
                    count: total,
                    year: String(year),
                  })}: ${breakdown}`}
                  role="img"
                  tabIndex={0}
                />
              }
            >
              {segments.map((segment) => (
                <rect
                  className={CITATION_TREATMENT_FILL[segment.treatment]}
                  height={segment.height}
                  key={segment.treatment}
                  width={COLUMN_WIDTH}
                  x={x}
                  y={segment.y}
                />
              ))}
            </TooltipTrigger>
            <TooltipPopup>
              <span className="font-medium">
                {t("caseLaw.citation.yearTitle", {
                  count: total,
                  year: String(year),
                })}
              </span>
              <span className="text-muted-foreground block text-xs">
                {breakdown}
              </span>
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </svg>
  );
};
