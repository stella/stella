import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 512,
  reason:
    "One joined live population scan includes the complete 16,384-delta window and its same-snapshot freshness marker. At both 180,020 and 360,020 decisions, the measured statement reads 435 shared pages, including the unvacuumed queue used by the production freshness function. The 512-page budget leaves 77 pages of fixture headroom while rejecting corpus-dependent reads. The bounded overlay serves courts, year bounds and pending text together; overflow serves only the folded snapshot.",
} as const satisfies ReadBudget;
