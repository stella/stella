import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  pages: 20_000,
  reason:
    "At most 48 indexed keyset pages of eight share one discovery transaction with a statement deadline, followed by queue batches of eight outside it. Three state probes read at most three rows each, and at most six fenced transitions include their aggregate locks and audits. State-leading expiry, heartbeat and queue indexes bound discovery; the unchanged 20,000-page ceiling covers tree depth, row locks and audit writes at both cardinalities.",
} as const satisfies ReadBudget;
