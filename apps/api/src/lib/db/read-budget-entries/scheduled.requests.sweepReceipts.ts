import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  pages: 20_000,
  reason:
    "Four rounds each discover at most 128 completed and 128 pending receipts, then lock and delete at most 128 scoped rows: 2,048 row visits. Nine index/heap pages per visit leave 1,568 pages for tenant-scope reads and fixed probes under the 20,000-page ungoverned ceiling. State-leading ordered expiry probes keep this independent of total receipt cardinality; PostgreSQL measures quiet, expired and mixed cohorts at both sizes.",
} as const satisfies ReadBudget;
