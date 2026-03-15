import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { hoursByUserOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/analytics";

import { formatHours } from "./utils";

type HoursByUserTableProps = {
  workspaceId: string;
  dateFrom?: string;
  dateTo?: string;
};

export const HoursByUserTable = ({
  workspaceId,
  dateFrom,
  dateTo,
}: HoursByUserTableProps) => {
  const t = useTranslations("analytics");
  const tc = useTranslations("common");
  const { data } = useSuspenseQuery(
    hoursByUserOptions(workspaceId, {
      dateFrom,
      dateTo,
    }),
  );

  return (
    <div className="bg-card rounded-lg border p-4">
      <h3 className="mb-4 text-sm font-medium">{t("hoursByUser")}</h3>
      {data.length === 0 ? (
        <p className="text-muted-foreground py-4 text-center text-sm">
          {t("noData")}
        </p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-start">
                <th className="pb-2 font-medium">{tc("user")}</th>
                <th className="pb-2 text-right font-medium">
                  {t("totalHours")}
                </th>
                <th className="pb-2 text-right font-medium">{t("entries")}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr className="border-b last:border-0" key={row.userId}>
                  <td className="py-2">{row.userName}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatHours(row.totalMinutes)}
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
