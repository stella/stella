import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { topTemplatesOptions } from "@/routes/_protected.knowledge/-queries/template-analytics";

type TopTemplatesTableProps = {
  dateFrom?: string;
  dateTo?: string;
};

export const TopTemplatesTable = ({
  dateFrom,
  dateTo,
}: TopTemplatesTableProps) => {
  const t = useTranslations("templateAnalytics");
  const { data } = useSuspenseQuery(topTemplatesOptions({ dateFrom, dateTo }));

  return (
    <div className="bg-card rounded-lg border p-4">
      <h3 className="mb-4 text-sm font-medium">{t("topTemplates")}</h3>
      {data.length === 0 ? (
        <p className="text-muted-foreground py-4 text-center text-sm">
          {t("noData")}
        </p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-start">
                <th className="pb-2 font-medium">{t("template")}</th>
                <th className="pb-2 text-end font-medium">{t("fills")}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr className="border-b last:border-0" key={row.templateId}>
                  <td className="py-2">{row.name}</td>
                  <td className="py-2 text-end tabular-nums">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
