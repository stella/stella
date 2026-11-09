import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 6000,
  reason:
    "Fixed 200 full-text matches: up to 12 pages each for eligibility and ranking, then 11 returned rows at up to 256 pages each for decision/search-document/identifier lookups and wide TOAST-backed section bodies, with 784 pages for the full-text probe and index depth. Body reads must depend on the returned page, not all matches.",
} as const satisfies ReadBudget;
