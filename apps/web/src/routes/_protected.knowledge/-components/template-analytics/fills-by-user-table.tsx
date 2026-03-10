import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { fillsByUserOptions } from "@/routes/_protected.knowledge/-queries/template-analytics";

type FillsByUserTableProps = {
  dateFrom?: string;
  dateTo?: string;
};

export const FillsByUserTable = ({
  dateFrom,
  dateTo,
}: FillsByUserTableProps) => {
  const t = useTranslations("templateAnalytics");
  const { data } = useSuspenseQuery(fillsByUserOptions({ dateFrom, dateTo }));

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium">{t("fillsByUser")}</h3>
      {data.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {t("noData")}
        </p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-start text-muted-foreground">
                <th className="pb-2 font-medium">{t("user")}</th>
                <th className="pb-2 text-right font-medium">{t("fills")}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr className="border-b last:border-0" key={row.userId}>
                  <td className="py-2">{row.userName}</td>
                  <td className="py-2 text-right tabular-nums">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
