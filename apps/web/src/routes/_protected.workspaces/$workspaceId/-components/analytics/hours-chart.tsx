import { useSuspenseQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTranslations } from "use-intl";

import { hoursByPeriodOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/analytics";
import { formatPeriodLabel } from "./utils";

type HoursChartProps = {
  workspaceId: string;
  dateFrom?: string;
  dateTo?: string;
  granularity?: "day" | "week" | "month";
};

export const HoursChart = ({
  workspaceId,
  dateFrom,
  dateTo,
  granularity = "week",
}: HoursChartProps) => {
  const t = useTranslations("analytics");
  const { data } = useSuspenseQuery(
    hoursByPeriodOptions(workspaceId, {
      dateFrom,
      dateTo,
      granularity,
    }),
  );

  const chartData = data.map((d) => ({
    period: formatPeriodLabel(d.period),
    hours: Math.round((d.totalMinutes / 60) * 10) / 10,
  }));

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium">{t("hoursByPeriod")}</h3>
      {chartData.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t("noData")}
        </p>
      ) : (
        <ResponsiveContainer height={300} width="100%">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="period" fontSize={12} tickLine={false} />
            <YAxis fontSize={12} tickLine={false} width={40} />
            <Tooltip
              contentStyle={{
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
                backgroundColor: "var(--popover)",
                color: "var(--popover-foreground)",
              }}
            />
            <Bar dataKey="hours" fill="var(--primary)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
};
