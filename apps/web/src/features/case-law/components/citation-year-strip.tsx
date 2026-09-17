import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import { CITATION_TREATMENT_FILL } from "@/features/case-law/citation-treatment";
import type { CitationYearCounts } from "@/features/case-law/citation-treatment";
import {
  CitationNegativeHatch,
  negativeHatchFill,
  useCitationHatchId,
} from "@/features/case-law/components/citation-negative-hatch";
import {
  citationTimelineColumns,
  citationTimelinePeak,
  MIN_VISIBLE_HEIGHT,
  stackColumnSegments,
} from "@/features/case-law/components/citation-timeline.logic";

/**
 * The hit area a control wrapping the strip needs. The strip is 16px tall and
 * the row around it barely 20px, well under the 44px a finger is entitled to,
 * so a coarse pointer gets a centred pseudo-element instead: the target grows,
 * the drawing does not.
 */
export const CITATION_TRIGGER_TOUCH_TARGET =
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-1/2 pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2";

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
 * No axes, no labels and no tab stops of its own: the strip is a glance at
 * the shape of a decision's reception, and it is drawn inside the control
 * that opens the timeline, where the year-by-year counts are. Focusable
 * columns here would be interactive content nested in a button, which
 * assistive technology flattens and the keyboard cannot reach usefully. Height scales to the busiest year
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
  const hatchId = useCitationHatchId();

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
      <CitationNegativeHatch
        id={hatchId}
        surfaceClassName="stroke-background"
      />
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

        return (
          <g key={year}>
            {segments.map((segment) => (
              <rect
                className={cn(
                  segment.treatment !== "negative" &&
                    CITATION_TREATMENT_FILL[segment.treatment],
                )}
                fill={negativeHatchFill(segment.treatment, hatchId)}
                height={segment.height}
                key={segment.treatment}
                width={COLUMN_WIDTH}
                x={x}
                y={segment.y}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
};
