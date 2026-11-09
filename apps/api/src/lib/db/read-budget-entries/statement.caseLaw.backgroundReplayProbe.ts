import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 32,
  reason:
    "One background replay lag probe against a 100,000-decision source the replay has caught up with, its worst case, beside a 100,000-decision source an older parser read: one LIMIT 1 read per arm (no parser version, an older one, unparsed input, not yet derived), each ordered along the replay-pending index, about two pages each plus the receipt exclusions. 32 pages leave room for a deeper production index without admitting a walk of the source.",
} as const satisfies ReadBudget;
