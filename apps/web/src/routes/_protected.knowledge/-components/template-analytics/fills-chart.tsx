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

import { fillsByPeriodOptions } from "@/routes/_protected.knowledge/-queries/template-analytics";

type FillsChartProps = {
  dateFrom?: string;
  dateTo?: string;
  granularity?: "day" | "week" | "month";
};

const formatPeriodLabel = (period: string): string => {
  const [y = 0, m = 1, d = 1] = period.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};

export const FillsChart = ({
  dateFrom,
  dateTo,
  granularity = "week",
}: FillsChartProps) => {
  const t = useTranslations("templateAnalytics");
  const { data } = useSuspenseQuery(
    fillsByPeriodOptions({ dateFrom, dateTo, granularity }),
  );

  const chartData = data.map((d) => ({
    period: formatPeriodLabel(d.period),
    count: d.count,
  }));

  return (
    <div className="bg-card rounded-lg border p-4">
      <h3 className="mb-4 text-sm font-medium">{t("fillsByPeriod")}</h3>
      {chartData.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t("noData")}
        </p>
      ) : (
        <ResponsiveContainer height={300} width="100%">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="period" fontSize={12} tickLine={false} />
            <YAxis
              allowDecimals={false}
              fontSize={12}
              tickLine={false}
              width={40}
            />
            <Tooltip
              contentStyle={{
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
                backgroundColor: "var(--popover)",
                color: "var(--popover-foreground)",
              }}
            />
            <Bar dataKey="count" fill="var(--primary)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
};
