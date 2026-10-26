import { useMemo } from "react";

import { defineChart, rect } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleUtc } from "d3-scale";
import { useFormatter, useTranslations } from "use-intl";

import { isEligibleLegislationExpression } from "@stll/api-contract/legislation-expression";
import type {
  LegislationExpressionKind,
  LegislationWindowDisposition,
} from "@stll/api-contract/legislation-expression";
import type MCP_APP_MESSAGES from "@stll/api-contract/mcp-app-messages";
import { cn } from "@stll/ui/utils";

import { timelineWindows } from "./model";
import type { ProvisionVersion, StatuteTimelineHistory } from "./parse";

type MessageKey = keyof typeof MCP_APP_MESSAGES.en;
const EXPRESSION_LABELS = {
  consolidation: "timelineKindConsolidation",
  promulgated: "timelineKindPromulgated",
  unversioned: "timelineKindUnversioned",
} as const satisfies Record<LegislationExpressionKind, MessageKey>;
const DISPOSITION_LABELS = {
  effective: "timelineDispositionEffective",
  "never-in-force": "timelineDispositionNeverInForce",
  "invalid-window": "timelineDispositionInvalidWindow",
  withdrawn: "timelineDispositionWithdrawn",
} as const satisfies Record<LegislationWindowDisposition, MessageKey>;

const versionDescription = (
  version: ProvisionVersion,
  t: ReturnType<typeof useTranslations>,
) =>
  `${t(EXPRESSION_LABELS[version.expressionKind])} · ${t(DISPOSITION_LABELS[version.windowDisposition])}`;

export const VersionLabel = ({ version }: { version: ProvisionVersion }) => {
  const t = useTranslations();
  return (
    <span
      data-window-disposition={version.windowDisposition}
      className={cn(
        "text-xs",
        !isEligibleLegislationExpression(version) &&
          "rounded border border-dashed px-1",
      )}
    >
      {versionDescription(version, t)}
    </span>
  );
};

export const TimelineChart = ({
  history,
  today,
  onSelect,
}: {
  history: StatuteTimelineHistory;
  today: string;
  onSelect: (documentId: string) => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const definition = useMemo(() => {
    const windows = timelineWindows(history.items, today);
    return defineChart({
      marks: [
        rect(
          windows.rows.filter((row) => !row.eligible),
          {
            x1: "start",
            x2: "end",
            y: "id",
            key: "id",
            fill: "none",
            stroke: "var(--foreground)",
            inset: 6,
          },
        ),
        rect(
          windows.rows.filter((row) => row.eligible && !row.current),
          {
            x1: "start",
            x2: "end",
            y: "id",
            key: "id",
            fill: "var(--foreground)",
            fillOpacity: 0.3,
            stroke: "var(--foreground)",
            inset: 6,
          },
        ),
        rect(
          windows.rows.filter((row) => row.current),
          {
            x1: "start",
            x2: "end",
            y: "id",
            key: "id",
            fill: "var(--foreground)",
            fillOpacity: 0.6,
            stroke: "var(--foreground)",
            strokeWidth: 2,
            inset: 6,
          },
        ),
      ],
      scales: {
        x: {
          scale: scaleUtc().domain([...windows.domain]),
          axis: {
            ticks: {
              count: 4,
              format: (value) =>
                format.dateTime(value, {
                  year: "numeric",
                  month: "short",
                  timeZone: "UTC",
                }),
            },
          },
        },
        y: {
          scale: scaleBand().domain(windows.rows.map((row) => row.id)),
          axis: false,
        },
      },
      theme: {
        foreground: "var(--foreground)",
        muted: "var(--muted-foreground)",
        background: "var(--background)",
        grid: "var(--border)",
      },
      keyboard: true,
    });
  }, [history.items, today, format]);
  return (
    <div
      data-testid="statute-timeline-chart"
      className="min-w-0 max-[480px]:hidden"
    >
      <Chart
        definition={definition}
        height={Math.max(140, history.items.length * 36 + 48)}
        initialWidth={640}
        ariaLabel={`${t("timelineTitle")}: ${history.items.map((version) => versionDescription(version, t)).join("; ")}`}
        onSelect={(point) => {
          if (point !== null) {
            onSelect(point.datum.id);
          }
        }}
      />
    </div>
  );
};
