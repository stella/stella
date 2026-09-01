import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";

import {
  CaseNumberCell,
  CountryPill,
  formatDecisionDate,
} from "@/features/case-law/components/decision-cells";
import type { Decision } from "@/features/case-law/components/decision-cells";
import { useFormatter } from "@/i18n/formatting-context";

export type { Decision } from "@/features/case-law/components/decision-cells";

// Stable keys so loading rows never fall back to array-index keys.
const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const SKELETON_CELL_KEYS = [
  "caseNumber",
  "court",
  "country",
  "date",
  "type",
] as const;

export const DecisionTable = ({ decisions, isLoading }: DecisionTableProps) => {
  const t = useTranslations();
  const format = useFormatter();

  if (!isLoading && decisions.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        {t("caseLaw.emptyState")}
      </p>
    );
  }

  return (
    <div className="border-border/45 bg-background/60 overflow-hidden rounded-md border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border/45 bg-muted/35 border-b">
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("caseLaw.columns.caseNumber")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.court")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.country")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.date")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.type")}
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading
              ? SKELETON_ROW_KEYS.map((rowKey) => (
                  <tr
                    className="border-border/35 border-b last:border-b-0"
                    key={rowKey}
                  >
                    {SKELETON_CELL_KEYS.map((cellKey) => (
                      <td className="px-4 py-2" key={cellKey}>
                        <Skeleton className="h-4 w-3/5" />
                      </td>
                    ))}
                  </tr>
                ))
              : decisions.map((decision) => (
                  <tr
                    className="border-border/35 hover:bg-muted/30 border-b last:border-b-0"
                    key={decision.id}
                  >
                    <td className="px-4 py-2">
                      <CaseNumberCell decision={decision} />
                    </td>
                    <td className="px-4 py-2">{decision.court}</td>
                    <td className="px-4 py-2">
                      <CountryPill country={decision.country} />
                    </td>
                    <td className="px-4 py-2">
                      {formatDecisionDate(decision.decisionDate, format)}
                    </td>
                    <td className="px-4 py-2">
                      {decision.decisionType ?? "—"}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

type DecisionTableProps = {
  decisions: Decision[];
  isLoading: boolean;
};
