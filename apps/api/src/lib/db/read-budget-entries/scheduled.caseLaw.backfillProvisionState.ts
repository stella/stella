import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  pages: 13_200,
  reason:
    "A governed run checks the shared backfill checkpoint and processes at most 200 bounded provision-state units; a completed pass reads only the checkpoint. 13,200 pages is the target for a run with pending units.",
  overBudget: {
    reason:
      "A run with pending units measures more than 110,000 pages at both source sizes (about 556 pages per unit), so one unit's lookups are far wider than its bounded work needs; the per-unit read is being narrowed.",
  },
} as const satisfies ReadBudget;
