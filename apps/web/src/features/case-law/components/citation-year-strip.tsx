import { useTranslations } from "use-intl";

import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import {
  CITATION_TREATMENT_FILL,
  CITATION_TREATMENT_LABEL,
} from "@/features/case-law/citation-treatment";
import type { CitationYearCounts } from "@/features/case-law/citation-treatment";
import {
  citationTimelineColumns,
  citationTimelinePeak,
  MIN_VISIBLE_HEIGHT,
  presentTreatments,
  stackColumnSegments,
} from "@/features/case-law/components/citation-timeline.logic";

const STRIP_HEIGHT = 16;
const COLUMN_WIDTH = 5;
const COLUMN_GAP = 1;

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

  const columns = citationTimelineColumns({ byYear, fromYear, toYear });
  const peak = citationTimelinePeak(columns);
  const width = columns.length * (COLUMN_WIDTH + COLUMN_GAP) - COLUMN_GAP;

  return (
    <svg
      aria-label={t("caseLaw.citation.stripLabel")}
      // The drawn width is a maximum, not a demand: a 60-year span is 359px
      // and the surfaces that hold the strip are narrower than that. It keeps
      // its full height when squeezed and compresses the years instead, since
      // the counts are what the strip is read for.
      className={cn("block max-w-full min-w-0 overflow-visible", className)}
      height={STRIP_HEIGHT}
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${String(width)} ${String(STRIP_HEIGHT)}`}
      width={width}
    >
      {columns.map(({ counts, total, year }, index) => {
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

        const columnHeight = Math.max(
          MIN_VISIBLE_HEIGHT,
          Math.round((total / peak) * STRIP_HEIGHT),
        );
        const segments = stackColumnSegments({
          baseline: STRIP_HEIGHT,
          columnHeight,
          counts,
        });

        const breakdown = presentTreatments(counts)
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
