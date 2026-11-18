import { useContext, useState } from "react";
import type { ComponentType } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { StreamdownContext } from "streamdown";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  isTableChartable,
  isTableChartPlanUsable,
  TABLE_CHART_KINDS,
  TABLE_CHART_LIMITS,
  type TableChartPlan,
  type TableChartRequest,
  type TableChartResponse,
  tableChartResponseSchema,
} from "@stll/api-contract/table-chart";
import { sha256Hex } from "@stll/sha256/browser";
import {
  ChartColumnIcon,
  ChartLineIcon,
  ChartNoAxesColumnIcon,
  ChartPieIcon,
  ChartScatterIcon,
} from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { SegmentedIconToggle } from "@stll/ui/segmented-icon-toggle";
import { TableChart } from "@stll/ui/table-chart";
import { Toggle } from "@stll/ui/toggle";

import { AnswerTable } from "@/components/ai-elements/answer-table";
import type { MarkdownTableProps } from "@/components/ai-elements/answer-table";
import {
  chartTableFromNode,
  tableChartPoints,
  tableChartValueLabel,
} from "@/components/chat/table-chart.logic";
import { useFormatter, useFormattingLocale } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

export type ChatTableChartProps = MarkdownTableProps & {
  cacheScope: readonly [organizationId: string, userId: string];
  requestPlan?: (table: TableChartRequest) => Promise<TableChartResponse>;
};

const requestTableChart = async (table: TableChartRequest) =>
  v.parse(
    tableChartResponseSchema,
    unwrapApiResponse(await api.chat["table-chart"].post(table)),
  );

/**
 * A chat answer's table: the shared answer table, with a chart toggle in its
 * header strip when the table has a numeric column.
 */
export const ChatTableChart = ({
  node,
  cacheScope,
  requestPlan = requestTableChart,
  ...props
}: ChatTableChartProps) => {
  const table = chartTableFromNode(node);
  // A table without a numeric column has no chart, so it offers none.
  const chartable = table !== null && isTableChartable(table) ? table : null;
  return (
    <ChartableAnswerTable
      cacheScope={cacheScope}
      node={node}
      requestPlan={requestPlan}
      table={chartable}
      {...props}
    />
  );
};

type ChartableAnswerTableProps = Omit<ChatTableChartProps, "requestPlan"> & {
  requestPlan: NonNullable<ChatTableChartProps["requestPlan"]>;
  table: TableChartRequest | null;
};

type Presentation =
  | { status: "table" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "chart"; plan: TableChartPlan };

type TableChartKind = TableChartPlan["kind"];

const KIND_OPTIONS = {
  bar: { icon: ChartColumnIcon, labelKey: "chat.tableChart.bar" },
  line: { icon: ChartLineIcon, labelKey: "chat.tableChart.line" },
  pie: { icon: ChartPieIcon, labelKey: "chat.tableChart.pie" },
  scatter: { icon: ChartScatterIcon, labelKey: "chat.tableChart.scatter" },
} as const satisfies Record<
  TableChartKind,
  { icon: ComponentType<{ className?: string }>; labelKey: TranslationKey }
>;

// One element whatever the table holds, so a table that becomes chartable
// while it streams keeps its shell (and its scroll position) as it is.
const ChartableAnswerTable = ({
  cacheScope,
  requestPlan,
  table,
  ...props
}: ChartableAnswerTableProps) => {
  const t = useTranslations();
  const formatter = useFormatter();
  const locale = useFormattingLocale();
  const queryClient = useQueryClient();
  const { isAnimating } = useContext(StreamdownContext);
  // A presentation belongs to the content it was chosen for: a streamed
  // change starts over from the table instead of applying an old plan.
  const contentKey = JSON.stringify([cacheScope, table]);
  const [chosen, setChosen] = useState<{
    contentKey: string;
    presentation: Presentation;
  }>({ contentKey, presentation: { status: "table" } });
  const presentation: Presentation =
    chosen.contentKey === contentKey
      ? chosen.presentation
      : { status: "table" };
  const present = (next: Presentation) =>
    setChosen({ contentKey, presentation: next });

  if (table === null) {
    return <AnswerTable {...props} />;
  }

  const showChart = async () => {
    present({ status: "loading" });
    const result = await Result.tryPromise(async () => {
      const hash = await sha256Hex(JSON.stringify(table));
      // The loader is bound to the complete source whose digest owns the cache entry.
      const loadPlan = async () => await requestPlan(table);
      return await queryClient.query(
        resourceQueryOptions(
          {
            queryKey: ["table-chart", cacheScope[0], cacheScope[1], hash],
            queryFn: loadPlan,
            staleTime: Infinity,
            gcTime: Infinity,
            retry: false,
          },
          { type: "independent" },
        ),
      );
    });
    if (Result.isError(result)) {
      getAnalytics().captureError(result.error, {
        fingerprintKey: "ChartableTable:showChart",
        scope: { type: "handler", handlerId: "chat.table-chart.show-chart" },
      });
      present({ status: "unavailable" });
      return;
    }
    const response = result.value;
    switch (response.status) {
      case "unavailable":
        present({ status: "unavailable" });
        return;
      case "ready":
        present(
          isTableChartPlanUsable(response.plan, table)
            ? { status: "chart", plan: response.plan }
            : { status: "unavailable" },
        );
    }
  };
  const chart = presentation.status === "chart" ? presentation.plan : null;
  const loading = presentation.status === "loading";
  const points = chart ? tableChartPoints({ table, plan: chart, locale }) : [];
  let keyPoints = points;
  if (points.length > 6) {
    const sortedPoints = points.toSorted((a, b) => b.y - a.y);
    keyPoints = sortedPoints
      .slice(0, 3)
      .concat(sortedPoints.slice(-3).toReversed());
  }
  const summary = chart
    ? [
        t("chat.tableChart.summary", { n: points.length }),
        ...keyPoints.map(({ label, y, series }) =>
          t("chat.tableChart.values", {
            label: series ? `${label} (${series})` : label,
            value: y,
          }),
        ),
      ].join(" ")
    : "";
  const toggleLabel = loading
    ? t("chat.tableChart.loading")
    : t("chat.tableChart.showChart");
  const axis = chart?.columns.find(
    ({ role }) => role === "x" || role === "label",
  );

  return (
    <AnswerTable
      {...props}
      actions={
        <>
          <Toggle
            aria-label={toggleLabel}
            disabled={isAnimating || loading}
            onPressedChange={(pressed) => {
              if (!pressed) {
                present({ status: "table" });
                return;
              }
              detached(showChart(), "chat-table-chart.choose");
            }}
            pressed={chart !== null}
            size="icon-xs"
            tooltip={toggleLabel}
            variant="ghost"
          >
            {loading ? (
              <Loader size="sm" variant="decorative" />
            ) : (
              <ChartNoAxesColumnIcon aria-hidden="true" />
            )}
          </Toggle>
          {chart && (
            <div role="group" aria-label={t("chat.tableChart.kind")}>
              <SegmentedIconToggle
                onChange={(kind) =>
                  present({
                    status: "chart",
                    plan: {
                      kind,
                      columns: chart.columns,
                      sort: chart.sort,
                      title: chart.title,
                    },
                  })
                }
                options={TABLE_CHART_KINDS.filter((kind) =>
                  isTableChartPlanUsable({ ...chart, kind }, table),
                ).map((kind) => ({
                  value: kind,
                  icon: KIND_OPTIONS[kind].icon,
                  label: t(KIND_OPTIONS[kind].labelKey),
                }))}
                value={chart.kind}
              />
            </div>
          )}
        </>
      }
      notice={
        presentation.status === "unavailable" ? (
          <p
            className="text-muted-foreground border-b px-3 py-2 text-sm"
            role="status"
          >
            {t("chat.tableChart.unavailable")}
          </p>
        ) : null
      }
      view={
        chart ? (
          <div className="p-3">
            <TableChart
              kind={chart.kind}
              points={points}
              title={
                chart.title ||
                table.headers
                  .join(" / ")
                  .slice(0, TABLE_CHART_LIMITS.titleCharacters)
              }
              summary={summary}
              xMode={axis?.role === "label" ? "category" : "numeric"}
              xLabel={table.headers.at(axis?.index ?? 0)}
              yLabel={tableChartValueLabel({ table, plan: chart })}
              formatNumber={(value) => formatter.number(value)}
            />
          </div>
        ) : null
      }
    />
  );
};
