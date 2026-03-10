import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { hoursByMatterOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/analytics";
import { formatHours } from "./utils";

type HoursByMatterTableProps = {
  workspaceId: string;
  dateFrom?: string;
  dateTo?: string;
};

export const HoursByMatterTable = ({
  workspaceId,
  dateFrom,
  dateTo,
}: HoursByMatterTableProps) => {
  const t = useTranslations("analytics");
  const { data } = useSuspenseQuery(
    hoursByMatterOptions(workspaceId, {
      dateFrom,
      dateTo,
    }),
  );

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium">{t("hoursByMatter")}</h3>
      {data.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {t("noData")}
        </p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-start text-muted-foreground">
                <th className="pb-2 font-medium">{t("matter")}</th>
                <th className="pb-2 text-right font-medium">
                  {t("totalHours")}
                </th>
                <th className="pb-2 text-right font-medium">
                  {t("billedHours")}
                </th>
                <th className="pb-2 text-right font-medium">{t("entries")}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr className="border-b last:border-0" key={row.matterId}>
                  <td className="py-2">{row.matterName}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatHours(row.totalMinutes)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatHours(row.billedMinutes)}
                  </td>
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
