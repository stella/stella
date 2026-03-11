import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { formatCurrencyAmount } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";
import { summaryOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/analytics";

import { formatHours } from "./utils";

type SummaryCardsProps = {
  workspaceId: string;
  dateFrom?: string;
  dateTo?: string;
};

export const SummaryCards = ({
  workspaceId,
  dateFrom,
  dateTo,
}: SummaryCardsProps) => {
  const t = useTranslations("analytics");
  const { data } = useSuspenseQuery(
    summaryOptions(workspaceId, { dateFrom, dateTo }),
  );

  const cards = [
    {
      label: t("totalHours"),
      value: formatHours(data.totalMinutes),
    },
    {
      label: t("billedAmount"),
      value: formatCurrencyAmount(data.billedAmount, data.currency),
    },
    {
      label: t("utilization"),
      value: `${data.utilization}%`,
    },
    {
      label: t("entryCount"),
      value: data.entryCount.toLocaleString(),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((card) => (
        <div className="bg-card rounded-lg border p-4" key={card.label}>
          <p className="text-muted-foreground text-sm">{card.label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
};
