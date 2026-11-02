import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 1500,
  statementDeadlineMs: 10_000,
  reason:
    "One 100-row completion page measured against a fully completed 100,000-decision source: 1,201 shared pages, plus 299 pages (25% headroom) for B-tree layout variation. The source page, receipt, and index-job decision indexes bound work before eligibility filtering.",
} as const satisfies ReadBudget;
