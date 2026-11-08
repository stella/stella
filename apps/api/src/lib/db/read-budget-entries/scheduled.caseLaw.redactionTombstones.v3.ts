import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  pages: 12_000,
  reason:
    "One 100-decision audit page, including durable pointer cleanup, search removal and inline publisher-payload cleanup. Measurements at 60,000 and 120,000 audited decisions stay below 9,100 shared pages; 12,000 leaves over 30% for deeper indexes and TOAST layout variation.",
} as const satisfies ReadBudget;
