import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import type { Element } from "hast";
import { defaultComponents } from "streamdown";
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
import { Button } from "@stll/ui/button";
import { TableChart } from "@stll/ui/table-chart";

import {
  chartTableFromNode,
  tableChartPoints,
} from "@/components/chat/table-chart.logic";
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";

export type ChatTableChartProps = ComponentProps<"table"> & {
  node?: Element | undefined;
  cacheScope: readonly [organizationId: string, userId: string];
  requestPlan?: (table: TableChartRequest) => Promise<TableChartResponse>;
};

const requestTableChart = async (table: TableChartRequest) =>
  v.parse(
    tableChartResponseSchema,
    unwrapApiResponse(await api.chat["table-chart"].post(table)),
  );

export const ChatTableChart = ({
  node,
  cacheScope,
  requestPlan = requestTableChart,
  ...props
}: ChatTableChartProps) => {
  const table = chartTableFromNode(node);
  const SourceTable = defaultComponents.table;
  // A table without a numeric column has no chart, so it offers none.
  if (table === null || !isTableChartable(table)) {
    return <SourceTable {...props} />;
  }
  // A streaming content change starts a new presentation instead of applying an old plan.
  return (
    <ChartableTable
      key={JSON.stringify([cacheScope, table])}
      table={table}
      source={<SourceTable {...props} />}
      cacheScope={cacheScope}
      requestPlan={requestPlan}
    />
  );
};

type ChartableTableProps = {
  table: TableChartRequest;
  source: ReactNode;
  cacheScope: ChatTableChartProps["cacheScope"];
  requestPlan: NonNullable<ChatTableChartProps["requestPlan"]>;
};
type Presentation =
  | { status: "table" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "chart"; plan: TableChartPlan };

const ChartableTable = ({
  table,
  source,
  cacheScope,
  requestPlan,
}: ChartableTableProps) => {
  const t = useTranslations();
  const formatter = useFormatter();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [presentation, setPresentation] = useState<Presentation>({
    status: "table",
  });
  const showChart = async () => {
    setPresentation({ status: "loading" });
    const result = await Result.tryPromise(async () => {
      const hash = await sha256Hex(JSON.stringify(table));
      // The loader is bound to the complete source whose digest owns the cache entry.
      const loadPlan = async () => await requestPlan(table);
      return await queryClient.query({
        queryKey: ["table-chart", cacheScope[0], cacheScope[1], hash],
        queryFn: loadPlan,
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
      });
    });
    if (Result.isError(result)) {
      getAnalytics().captureError(result.error, {
        fingerprintKey: "ChartableTable:showChart",
        scope: { type: "handler", handlerId: "chat.table-chart.show-chart" },
      });
      setPresentation({ status: "unavailable" });
      return;
    }
    const response = result.value;
    switch (response.status) {
      case "unavailable":
        setPresentation({ status: "unavailable" });
        return;
      case "ready":
        setPresentation(
          isTableChartPlanUsable(response.plan, table)
            ? { status: "chart", plan: response.plan }
            : { status: "unavailable" },
        );
    }
  };
  const kindLabels = {
    bar: t("chat.tableChart.bar"),
    line: t("chat.tableChart.line"),
    pie: t("chat.tableChart.pie"),
    scatter: t("chat.tableChart.scatter"),
  };
  const chart = presentation.status === "chart" ? presentation.plan : null;
  const points = chart ? tableChartPoints({ table, plan: chart, locale }) : [];
  let toggleLabel = t("chat.tableChart.showChart");
  if (presentation.status === "loading") {
    toggleLabel = t("chat.tableChart.loading");
  }
  if (chart) {
    toggleLabel = t("workspaces.views.timeline.showTable");
  }
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
  return (
    <div className="my-3 min-w-0" data-slot="chat-table-chart">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={presentation.status === "loading"}
          aria-pressed={chart !== null}
          onClick={() => {
            if (chart) {
              setPresentation({ status: "table" });
              return;
            }
            detached(showChart(), "chat-table-chart.choose");
          }}
        >
          {toggleLabel}
        </Button>
        {chart && (
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label={t("chat.tableChart.kind")}
          >
            {TABLE_CHART_KINDS.filter((kind) =>
              isTableChartPlanUsable({ ...chart, kind }, table),
            ).map((kind) => (
              <Button
                key={kind}
                size="xs"
                variant="ghost"
                aria-pressed={chart.kind === kind}
                onClick={() =>
                  setPresentation({
                    status: "chart",
                    plan: {
                      kind,
                      columns: chart.columns,
                      sort: chart.sort,
                      title: chart.title,
                    },
                  })
                }
              >
                {kindLabels[kind]}
              </Button>
            ))}
          </div>
        )}
      </div>
      {presentation.status === "unavailable" && (
        <p role="status" className="text-muted-foreground mb-2 text-sm">
          {t("chat.tableChart.unavailable")}
        </p>
      )}
      {chart && (
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
          xMode={
            chart.columns.find(({ role }) => role === "x" || role === "label")
              ?.role === "label"
              ? "category"
              : "numeric"
          }
          xLabel={table.headers.at(
            chart.columns.find(({ role }) => role === "x" || role === "label")
              ?.index ?? 0,
          )}
          yLabel={chart.columns
            .filter(({ role }) => role === "y")
            .map(({ index }) => table.headers.at(index))
            .join(" / ")}
          formatNumber={(value) => formatter.number(value)}
        />
      )}
      <div hidden={chart !== null}>{source}</div>
    </div>
  );
};
