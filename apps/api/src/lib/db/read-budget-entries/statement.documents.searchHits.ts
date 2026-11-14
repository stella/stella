import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 1550,
  reason:
    "One page of document-search hits under row security, measured on the growth profile (100,000 documents, 200 matches, one matter in a hundred selected): the full-text index probe of the matches plus their entity and membership checks.",
} as const satisfies ReadBudget;
