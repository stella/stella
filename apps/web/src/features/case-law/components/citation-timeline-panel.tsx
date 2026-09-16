import { useId } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { PopoverClose, PopoverTitle } from "@stll/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { createCaseDecisionDetailsTab } from "@/components/inspector/case-decision-details-view";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  CITATION_TREATMENT_DOT,
  CITATION_TREATMENT_FILL,
  CITATION_TREATMENT_LABEL,
  totalCitations,
} from "@/features/case-law/citation-treatment";
import type {
  CitationTreatment,
  CitationTreatmentCounts,
  CitationYearCounts,
  DecisionCitationSummary,
} from "@/features/case-law/citation-treatment";
import {
  citationTimelineColumns,
  citationTimelinePeak,
  lastNegativeYear,
  MIN_VISIBLE_HEIGHT,
  peakTimelineColumn,
  presentTreatments,
  stackColumnSegments,
  timelineTickYears,
} from "@/features/case-law/components/citation-timeline.logic";
import type { TimelineColumn } from "@/features/case-law/components/citation-timeline.logic";
import { useFormatter } from "@/i18n/formatting-context";

/** The panel's own width, minus its padding: the plot is drawn at this size. */
const CHART_WIDTH = 288;
/** Room above the plot for the one count the chart labels directly. */
const PEAK_LABEL_HEIGHT = 11;
const PLOT_HEIGHT = 72;
const BASELINE_Y = PEAK_LABEL_HEIGHT + PLOT_HEIGHT;
const AXIS_LABEL_BASELINE = BASELINE_Y + 11;
const CHART_HEIGHT = AXIS_LABEL_BASELINE + 3;
/** Widest a four-digit year gets at the axis font size, plus breathing room. */
const AXIS_LABEL_WIDTH = 34;
/** Below this slot width a 2px gap costs more than it separates. */
const WIDE_SLOT = 6;

type ColumnLayout = {
  /** What one year owns, bar plus the gap to the next: the hover target. */
  slot: number;
  /** The painted bar, narrower than the slot by the gap it leaves. */
  width: number;
};

const columnLayout = (count: number): ColumnLayout => {
  const slot = CHART_WIDTH / count;
  const gap = slot >= WIDE_SLOT ? 2 : 1;
  return { slot, width: Math.max(1, slot - gap) };
};

type CitationTimelinePanelProps = {
  /** First year the chart draws; the strip that opened it drew the same. */
  fromYear: number;
  summary: DecisionCitationSummary;
  /** The decision, as the citing-decisions tab needs it addressed. */
  target: Parameters<typeof createCaseDecisionDetailsTab>[0];
  /** Last year drawn, inclusive. */
  toYear: number;
};

/**
 * A decision's reception in full: how often it was cited in each year of the
 * span, how the citing courts treated it, and the way to the decisions
 * themselves. What the strip shows at a glance, opened up.
 */
export const CitationTimelinePanel = ({
  fromYear,
  summary,
  target,
  toYear,
}: CitationTimelinePanelProps) => {
  const t = useTranslations();
  const total = totalCitations(summary.incoming);
  const lastNegative = lastNegativeYear(summary.incomingByYear);

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <PopoverTitle className="text-foreground text-sm font-medium">
          {t("caseLaw.citation.citedSummary", { count: total })}
        </PopoverTitle>
        <p className="text-muted-foreground text-xs">
          {t("caseLaw.citation.stripLabel")}
        </p>
      </div>
      <CitationTimelineChart
        byYear={summary.incomingByYear}
        fromYear={fromYear}
        toYear={toYear}
      />
      <TreatmentLegend counts={summary.incoming} />
      {lastNegative !== null && (
        <p className="text-destructive text-xs">
          {t("caseLaw.citation.lastNegative", { year: String(lastNegative) })}
        </p>
      )}
      <PopoverClose
        render={
          <Button
            className="w-fit"
            onClick={() => {
              useInspectorTabsStore
                .getState()
                .openView(createCaseDecisionDetailsTab(target));
            }}
            size="sm"
            variant="outline"
          />
        }
      >
        {t("caseLaw.citation.showAll", { count: total })}
      </PopoverClose>
    </>
  );
};

type CitationTimelineChartProps = {
  byYear: readonly CitationYearCounts[];
  fromYear: number;
  toYear: number;
};

/**
 * Citations per year, stacked by treatment, on a labelled axis. Bars scale
 * to the busiest year in view and only that year carries a printed count:
 * the rest are a hover or a tab stop away, which keeps the axis readable at
 * every span the timeline can reach.
 */
const CitationTimelineChart = ({
  byYear,
  fromYear,
  toYear,
}: CitationTimelineChartProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const hatchId = useId();

  if (toYear < fromYear) {
    return null;
  }

  const columns = citationTimelineColumns({ byYear, fromYear, toYear });
  const peak = citationTimelinePeak(columns);
  const peakColumn = peakTimelineColumn(columns);
  const layout = columnLayout(columns.length);
  const ticks = new Set(
    timelineTickYears({
      maxTicks: Math.floor(CHART_WIDTH / AXIS_LABEL_WIDTH),
      years: columns.map((column) => column.year),
    }),
  );
  const centerOf = (index: number) => index * layout.slot + layout.width / 2;

  return (
    <svg
      aria-label={t("caseLaw.citation.stripLabel")}
      className="block h-auto w-full"
      height={CHART_HEIGHT}
      role="img"
      viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
      width={CHART_WIDTH}
    >
      {/* Negative treatment is the one figure a reader must not miss, so it
          is hatched as well as coloured: colour alone fails a colour-blind
          reader, a monochrome print, and forced-colours mode. */}
      <defs>
        <pattern
          height="3"
          id={hatchId}
          patternTransform="rotate(45)"
          patternUnits="userSpaceOnUse"
          width="3"
        >
          <rect className="fill-destructive" height="3" width="3" />
          <line
            className="stroke-popover"
            strokeWidth="1.25"
            x1="0"
            x2="0"
            y1="0"
            y2="3"
          />
        </pattern>
      </defs>
      {columns.map((column, index) => (
        <TimelineBar
          column={column}
          hatchId={hatchId}
          key={column.year}
          layout={layout}
          peak={peak}
          x={index * layout.slot}
        />
      ))}
      <line
        className="stroke-border"
        strokeWidth="1"
        x1="0"
        x2={CHART_WIDTH}
        y1={BASELINE_Y + 0.5}
        y2={BASELINE_Y + 0.5}
      />
      {peakColumn !== undefined && (
        <text
          className="fill-muted-foreground text-[9px] tabular-nums"
          textAnchor="middle"
          x={Math.min(
            CHART_WIDTH - 8,
            Math.max(8, centerOf(columns.indexOf(peakColumn))),
          )}
          y={PEAK_LABEL_HEIGHT - 3}
        >
          {format.number(peakColumn.total)}
        </text>
      )}
      {columns.map(({ year }, index) => {
        if (!ticks.has(year)) {
          return null;
        }
        const { anchor, x } = axisTickPlacement({
          center: centerOf(index),
          index,
          lastIndex: columns.length - 1,
        });
        return (
          <text
            className="fill-muted-foreground text-[9px]"
            key={year}
            textAnchor={anchor}
            x={x}
            y={AXIS_LABEL_BASELINE}
          >
            {String(year)}
          </text>
        );
      })}
    </svg>
  );
};

type AxisTickPlacement = {
  anchor: "end" | "middle" | "start";
  x: number;
};

/** The span's ends are read off the chart's edges; the rest sit on a bar. */
const axisTickPlacement = ({
  center,
  index,
  lastIndex,
}: {
  center: number;
  index: number;
  lastIndex: number;
}): AxisTickPlacement => {
  if (index === 0) {
    return { anchor: "start", x: 0 };
  }
  if (index === lastIndex) {
    return { anchor: "end", x: CHART_WIDTH };
  }
  return { anchor: "middle", x: center };
};

type TimelineBarProps = {
  column: TimelineColumn;
  hatchId: string;
  layout: ColumnLayout;
  peak: number;
  x: number;
};

const TimelineBar = ({
  column: { counts, total, year },
  hatchId,
  layout,
  peak,
  x,
}: TimelineBarProps) => {
  const t = useTranslations();

  if (counts === undefined) {
    return (
      <rect
        className="fill-border"
        height={MIN_VISIBLE_HEIGHT}
        width={layout.width}
        x={x}
        y={BASELINE_Y - MIN_VISIBLE_HEIGHT}
      />
    );
  }

  const columnHeight = Math.max(
    MIN_VISIBLE_HEIGHT,
    Math.round((total / peak) * PLOT_HEIGHT),
  );
  const segments = stackColumnSegments({
    baseline: BASELINE_Y,
    columnHeight,
    counts,
  });
  const breakdown = presentTreatments(counts)
    .map(
      (treatment) =>
        `${t(CITATION_TREATMENT_LABEL[treatment])} ${String(counts[treatment])}`,
    )
    .join(" · ");
  const title = t("caseLaw.citation.yearTitle", {
    count: total,
    year: String(year),
  });

  return (
    <Tooltip>
      {/* A group is not focusable by itself; the tab stop and label give
          keyboard and screen-reader users the same per-year breakdown the
          tooltip shows on hover. */}
      <TooltipTrigger
        render={
          <g aria-label={`${title}: ${breakdown}`} role="img" tabIndex={0} />
        }
      >
        {/* The whole slot answers the pointer, so a one-citation year is as
            easy to hit as the peak. */}
        <rect
          fillOpacity="0"
          height={PLOT_HEIGHT}
          width={layout.slot}
          x={x}
          y={PEAK_LABEL_HEIGHT}
        />
        {segments.map((segment) => (
          <rect
            className={cn(
              segment.treatment !== "negative" &&
                CITATION_TREATMENT_FILL[segment.treatment],
              "stroke-popover",
            )}
            fill={
              segment.treatment === "negative" ? `url(#${hatchId})` : undefined
            }
            height={segment.height}
            key={segment.treatment}
            // Segments meet edge to edge; a hairline of the surface between
            // them keeps two dark treatments from reading as one bar, and is
            // dropped where the segment is too thin to survive it.
            strokeWidth={segment.height >= 3 ? 1 : 0}
            width={layout.width}
            x={x}
            y={segment.y}
          />
        ))}
      </TooltipTrigger>
      <TooltipPopup>
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs">{breakdown}</span>
      </TooltipPopup>
    </Tooltip>
  );
};

/**
 * The chart's key, which is also the treatment rollup: every treatment the
 * decision actually carries, its colour, and how many citations it holds.
 */
const TreatmentLegend = ({ counts }: { counts: CitationTreatmentCounts }) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0">
      {presentTreatments(counts).map((treatment) => (
        <li
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          key={treatment}
        >
          <LegendSwatch treatment={treatment} />
          <span className="text-foreground-strong-muted tabular-nums">
            {format.number(counts[treatment])}
          </span>
          <span className="truncate">
            {t(CITATION_TREATMENT_LABEL[treatment])}
          </span>
        </li>
      ))}
    </ul>
  );
};

/** Negative carries the chart's hatch, so the key matches the bars. */
const LegendSwatch = ({ treatment }: { treatment: CitationTreatment }) => {
  if (treatment === "negative") {
    return (
      <span
        aria-hidden="true"
        className="border-destructive bg-destructive size-2 shrink-0 rounded-[2px] border bg-[repeating-linear-gradient(45deg,transparent_0_1px,var(--color-popover)_1px_2px)]"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        CITATION_TREATMENT_DOT[treatment],
      )}
    />
  );
};
