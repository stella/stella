import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { PopoverClose, PopoverTitle } from "@stll/ui/popover";
import { Skeleton } from "@stll/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { createCaseDecisionDetailsTab } from "@/components/inspector/case-decision-details-view";
import { createCaseDecisionViewTab } from "@/components/inspector/case-decision-view";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { decisionYear, formatYear } from "@/features/case-law/citation-format";
import {
  CITATION_TREATMENT_DOT,
  CITATION_TREATMENT_FILL,
  CITATION_TREATMENT_LABEL,
  CITATION_TREATMENT_ORDER,
  totalCitations,
} from "@/features/case-law/citation-treatment";
import type {
  CitationTreatmentCounts,
  CitationYearCounts,
  DecisionCitationSummary,
} from "@/features/case-law/citation-treatment";
import {
  CitationNegativeHatch,
  negativeHatchFill,
  useCitationHatchId,
} from "@/features/case-law/components/citation-negative-hatch";
import {
  citationTimelineColumns,
  citationTimelinePeak,
  lastNegativeYear,
  MIN_VISIBLE_HEIGHT,
  peakTimelineColumn,
  presentTreatments,
  stackColumnSegments,
  timelineTickYears,
  topCitingDecisions,
} from "@/features/case-law/components/citation-timeline.logic";
import type { TimelineColumn } from "@/features/case-law/components/citation-timeline.logic";
import { CitationTreatmentBar } from "@/features/case-law/components/citation-treatment-bar";
import { decisionLeadingCitationsOptions } from "@/features/case-law/queries/citations";
import type { LeadingCitation } from "@/features/case-law/queries/citations";
import { useFormatter } from "@/i18n/formatting-context";
import { citedDecisionLabel } from "@/lib/cited-decision-label";
import { detached } from "@/lib/detached";

/** The panel's own width, minus its padding: the plot is drawn at this size. */
const CHART_WIDTH = 350;
/** How many citing decisions the panel names before handing over to the list. */
const CITING_DECISIONS_SHOWN = 5;
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
 * A decision's reception in full: how the citing courts treated it, whether
 * anyone has gone against it lately, when it was cited, and which of the
 * decisions citing it carry the most weight. The strip says how often; this
 * says by whom, how, and whether it still holds.
 */
export const CitationTimelinePanel = ({
  fromYear,
  summary,
  target,
  toYear,
}: CitationTimelinePanelProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const total = totalCitations(summary.incoming);
  const lastNegative = lastNegativeYear(summary.incomingByYear);

  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <PopoverTitle className="text-foreground text-sm font-medium">
          {t("caseLaw.viewer.citedBy")}
        </PopoverTitle>
        <span className="text-muted-foreground text-xs tabular-nums">
          {format.number(total)}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <CitationTreatmentBar
          className="h-2"
          counts={summary.incoming}
          total={total}
        />
        <TreatmentCounts counts={summary.incoming} />
        {lastNegative !== null && (
          <p className="text-destructive text-xs">
            {t("caseLaw.citation.lastNegative", {
              year: formatYear(format, lastNegative),
            })}
          </p>
        )}
      </div>

      <CitationTimelineChart
        byYear={summary.incomingByYear}
        fromYear={fromYear}
        toYear={toYear}
      />

      <CitingDecisions target={target} />

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

/**
 * What the proportion bar above is made of, in the same order and the same
 * colours. Negative leads and wears the ink it is drawn in: it is the count
 * a reader came for.
 */
const TreatmentCounts = ({ counts }: { counts: CitationTreatmentCounts }) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
      {CITATION_TREATMENT_ORDER.filter(
        (treatment) => counts[treatment] > 0,
      ).map((treatment) => (
        <li
          className={cn(
            "text-muted-foreground flex items-center gap-1.5 text-xs",
            treatment === "negative" && "text-destructive font-medium",
          )}
          key={treatment}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              CITATION_TREATMENT_DOT[treatment],
            )}
          />
          <span className="tabular-nums">
            {format.number(counts[treatment])}
          </span>
          {t(CITATION_TREATMENT_LABEL[treatment])}
        </li>
      ))}
    </ul>
  );
};

/**
 * The decisions citing this one that carry the most weight, ranked the way
 * the citator ranks them. The payoff of opening the panel: a case number, a
 * court and a year answer "who follows this?" as no bar chart can.
 */
const CitingDecisions = ({
  target,
}: {
  target: CitationTimelinePanelProps["target"];
}) => {
  const t = useTranslations();
  const {
    data: leading,
    isError,
    refetch,
  } = useQuery(decisionLeadingCitationsOptions(target.decisionId, "incoming"));

  if (isError) {
    return (
      <div className="flex items-center gap-2">
        <p className="text-muted-foreground text-xs">
          {t("errors.actionFailed")}
        </p>
        <Button
          className="text-xs"
          onClick={() => {
            detached(refetch(), "case-law.citation-timeline-retry");
          }}
          size="sm"
          variant="ghost"
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (leading === undefined) {
    return <CitingDecisionsLoader />;
  }

  const rows = topCitingDecisions(leading, CITING_DECISIONS_SHOWN);
  if (rows.length === 0) {
    return null;
  }

  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map((row) => (
        <CitingDecisionRow key={row.id} row={row} />
      ))}
    </ul>
  );
};

const CitingDecisionRow = ({ row }: { row: LeadingCitation }) => {
  const t = useTranslations();
  const format = useFormatter();
  const inspector = useInspectorView();
  const year = decisionYear(row.decision.decisionDate);

  return (
    <li className="flex">
      {/* The panel steps aside for the decision it sent the reader to. */}
      <PopoverClose
        render={
          <button
            className="hover:bg-muted/60 -mx-1.5 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start"
            onClick={() => {
              inspector.open(
                createCaseDecisionViewTab({
                  caseNumber: row.decision.caseNumber,
                  country: row.decision.country,
                  court: row.decision.court,
                  decisionId: row.decision.id,
                  language: row.decision.language,
                  languageAlternates: row.decision.languageAlternates,
                  slug: row.decision.slug,
                }),
              );
            }}
            type="button"
          />
        }
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <BidiText
            as="span"
            className="text-foreground-strong-muted truncate text-xs font-medium"
          >
            {citedDecisionLabel(row.decision)}
          </BidiText>
          <BidiText
            as="span"
            className="text-muted-foreground truncate text-[0.7rem]"
          >
            {year === null
              ? row.decision.court
              : `${row.decision.court} · ${formatYear(format, year)}`}
          </BidiText>
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-[0.7rem]",
            row.treatment === "negative"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              CITATION_TREATMENT_DOT[row.treatment],
            )}
          />
          {t(CITATION_TREATMENT_LABEL[row.treatment])}
        </span>
      </PopoverClose>
    </li>
  );
};

/** The shape of the rows to come, so the panel does not jump when they land. */
const CitingDecisionsLoader = () => (
  <div className="flex flex-col gap-2">
    {[0, 1, 2].map((row) => (
      <div className="flex flex-col gap-1" key={row}>
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-2.5 w-28" />
      </div>
    ))}
  </div>
);

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
  const hatchId = useCitationHatchId();

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
      // A time axis runs oldest to newest whichever way the UI reads, so the
      // plot states its own direction: inherited RTL would flip what `start`
      // and `end` mean for the endpoint labels and hang them off the edges.
      className="block h-auto w-full [direction:ltr]"
      height={CHART_HEIGHT}
      role="img"
      viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
      width={CHART_WIDTH}
    >
      <CitationNegativeHatch id={hatchId} surfaceClassName="stroke-popover" />
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
            {formatYear(format, year)}
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
  const format = useFormatter();

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
        `${t(CITATION_TREATMENT_LABEL[treatment])} ${format.number(counts[treatment])}`,
    )
    .join(" · ");
  const title = t("caseLaw.citation.yearTitle", {
    count: total,
    year: formatYear(format, year),
  });

  return (
    <Tooltip>
      {/* A group is not focusable by itself; the tab stop and label give
          keyboard and screen-reader users the same per-year breakdown the
          tooltip shows on hover. */}
      <TooltipTrigger
        render={
          <g
            aria-label={`${title}: ${breakdown}`}
            // A pointer never draws the ring: clicking a bar focuses the
            // group, and a ring round one column reads as a selection the
            // chart does not have.
            className="focus-visible:outline-ring outline-none focus-visible:outline-2 focus-visible:outline-offset-1"
            role="img"
            tabIndex={0}
          />
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
            fill={negativeHatchFill(segment.treatment, hatchId)}
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
