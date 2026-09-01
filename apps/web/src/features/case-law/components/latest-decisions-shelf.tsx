import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { DecisionTable } from "@/features/case-law/components/decision-table";
import type { Decision } from "@/features/case-law/components/decision-table";

export type LatestDecisionsCourt = {
  court: string;
  decisions: readonly Decision[];
};

type LatestDecisionsShelfProps = {
  /** The pill's value, so "show all" keeps the reader's scope. */
  countryParam: string;
  courts: readonly LatestDecisionsCourt[];
  hiddenColumnIds: readonly string[];
};

/**
 * What the browse page shows before anything is typed: the newest decisions
 * of the jurisdiction's largest courts, in the same table the results use,
 * so the page's shape does not change when a search begins.
 */
export const LatestDecisionsShelf = ({
  countryParam,
  courts,
  hiddenColumnIds,
}: LatestDecisionsShelfProps) => {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-6">
      {courts.map(({ court, decisions }) => (
        <section className="flex flex-col gap-2" key={court}>
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-foreground text-sm font-medium">{court}</h2>
            <Link
              className="text-muted-foreground hover:text-foreground shrink-0 text-xs transition-colors"
              search={{ country: countryParam, court }}
              to="/law/cases"
            >
              {t("common.showAll")}
            </Link>
          </div>
          <DecisionTable
            decisions={decisions}
            hiddenColumnIds={hiddenColumnIds}
            isLoading={false}
            order="newest"
          />
        </section>
      ))}
    </div>
  );
};
