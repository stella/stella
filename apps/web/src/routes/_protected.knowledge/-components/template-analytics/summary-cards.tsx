import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { templateSummaryOptions } from "@/routes/_protected.knowledge/-queries/template-analytics";

type SummaryCardsProps = {
  dateFrom?: string;
  dateTo?: string;
};

export const SummaryCards = ({ dateFrom, dateTo }: SummaryCardsProps) => {
  const t = useTranslations("templateAnalytics");
  const { data } = useSuspenseQuery(
    templateSummaryOptions({ dateFrom, dateTo }),
  );

  const cards = [
    {
      label: t("totalFills"),
      value: data.totalFills.toLocaleString(),
    },
    {
      label: t("uniqueTemplates"),
      value: `${data.uniqueTemplates} / ${data.templateCount}`,
    },
    {
      label: t("pdfRatio"),
      value: `${data.pdfRatio}%`,
    },
    {
      label: t("errorRate"),
      value: `${data.errorRate}%`,
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
