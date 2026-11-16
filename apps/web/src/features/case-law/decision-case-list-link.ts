import { linkOptions } from "@tanstack/react-router";

import type { CaseLawIndexSearch } from "@/features/case-law/case-law-index-search.logic";
import { toCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";

/** A decision's list links always follow its jurisdiction, including in side views. */
export const decisionCaseListLink = (
  decision: Pick<PublicCaseLawDecision, "country">,
  filters: Omit<CaseLawIndexSearch, "country"> = {},
) =>
  linkOptions({
    to: "/law/cases",
    search: { ...filters, country: toCaseLawCountryParam(decision.country) },
  });
