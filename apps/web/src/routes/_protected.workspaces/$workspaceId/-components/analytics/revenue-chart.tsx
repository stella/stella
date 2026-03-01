import { useSuspenseQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTranslations } from "use-intl";

import { revenueByPeriodOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/analytics";
import { formatPeriodLabel } from "./utils";

type RevenueChartProps = {
  workspaceId: string;
  dateFrom?: string;
  dateTo?: string;
  granularity?: "day" | "week" | "month";
};

export const RevenueChart = ({
  workspaceId,
  dateFrom,
  dateTo,
  granularity = "week",
}: RevenueChartProps) => {
  const t = useTranslations("analytics");
  const { data } = useSuspenseQuery(
    revenueByPeriodOptions(workspaceId, {
      dateFrom,
      dateTo,
      granularity,
    }),
  );

  const chartData = data.map((d) => ({
    period: formatPeriodLabel(d.period),
    revenue: d.revenue,
  }));

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium">{t("revenueByPeriod")}</h3>
      {chartData.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t("noData")}
        </p>
      ) : (
        <ResponsiveContainer height={300} width="100%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="revenueGradient" x1="0" x2="0" y1="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--primary)"
                  stopOpacity={0.2}
                />
                <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="period" fontSize={12} tickLine={false} />
            <YAxis fontSize={12} tickLine={false} width={60} />
            <Tooltip
              contentStyle={{
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
                backgroundColor: "var(--popover)",
                color: "var(--popover-foreground)",
              }}
            />
            <Area
              dataKey="revenue"
              fill="url(#revenueGradient)"
              stroke="var(--primary)"
              strokeWidth={2}
              type="monotone"
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
};
