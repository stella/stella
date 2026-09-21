import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { CourtName } from "@/features/case-law/components/court-name";
import type { CourtTier } from "@/features/case-law/decision-filter-facets.logic";

/** The three things a row of a court breakdown can stand for. */
export type CourtBreakdownRow =
  | { type: "court"; court: string; courtAbbreviation: string | null }
  | { type: "tier"; courts: number }
  | { type: "unlisted"; listed: number };

type CourtRowLabelProps = {
  row: CourtBreakdownRow;
  tier: CourtTier;
};

/**
 * What a breakdown row stands for: one court by name, a whole tier of them,
 * or every court beyond the ones the breakdown lists. One component for the
 * coverage page and the corpus-status popover, so the two name the same row
 * the same way.
 */
export const CourtRowLabel = ({ row, tier }: CourtRowLabelProps) => {
  const t = useTranslations();

  switch (row.type) {
    case "court":
      return (
        <CourtName
          abbreviation={row.courtAbbreviation}
          court={row.court}
          tier={tier}
        />
      );
    case "tier":
      return (
        <span className="text-muted-foreground">
          {t("caseLaw.corpusStatus.courtCount", { count: row.courts })}
        </span>
      );
    case "unlisted":
      return (
        <span className="text-muted-foreground">
          {t("caseLaw.corpusStatus.unlistedCourts", { count: row.listed })}
        </span>
      );
    default: {
      row satisfies never;
      return panic("Unhandled case-law court row type");
    }
  }
};
