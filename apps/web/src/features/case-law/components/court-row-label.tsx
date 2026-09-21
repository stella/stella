import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { CourtName } from "@/features/case-law/components/court-name";
import {
  COURT_TIER_LABEL_KEYS,
  type CourtTier,
  isCourtTier,
} from "@/features/case-law/decision-filter-facets.logic";

/** The three things a row of a court breakdown can stand for. */
export type CourtBreakdownRow =
  | {
      type: "court";
      court: string;
      courtAbbreviation: string | null;
      tier: string;
    }
  | { type: "tier"; tier: string; courts: number }
  | { type: "unlisted"; listed: number };

/**
 * A tier the UI has a label for. A label it does not know folds into the
 * catch-all, exactly as the facet rail folds one: a court the reader cannot
 * see is a court they cannot account for.
 */
const uiTier = (tier: string): CourtTier =>
  isCourtTier(tier) ? tier : "other";

/**
 * What a breakdown row stands for: one court by name, a whole tier of them,
 * or every court beyond the ones the breakdown lists. One component for the
 * coverage page and the corpus-status popover, so the two name the same row
 * the same way. The rows stand in one flat list, so a tier row names its
 * tier itself rather than sitting under a heading.
 */
export const CourtRowLabel = ({ row }: { row: CourtBreakdownRow }) => {
  const t = useTranslations();

  switch (row.type) {
    case "court":
      return (
        <CourtName
          abbreviation={row.courtAbbreviation}
          court={row.court}
          tier={uiTier(row.tier)}
        />
      );
    case "tier":
      return (
        <span className="inline-flex min-w-0 items-baseline gap-1.5">
          <span className="truncate">
            {t(COURT_TIER_LABEL_KEYS[uiTier(row.tier)])}
          </span>
          <span className="text-muted-foreground shrink-0">
            {t("caseLaw.corpusStatus.courtCount", { count: row.courts })}
          </span>
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
