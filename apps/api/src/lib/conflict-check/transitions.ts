import { conflictChecks } from "@/api/db/schema";
import { defineScopedTransitions } from "@/api/lib/db/transitions";

/**
 * A check's decision. A recorded decision may be replaced by another (a
 * conflict later waived once the client consents), never returned to
 * `pending`.
 */
export const CONFLICT_CHECK_DECISION_TRANSITIONS = defineScopedTransitions({
  table: conflictChecks,
  key: "id",
  scope: ["organizationId"],
  stateColumn: "decision",
  edges: {
    pending: ["cleared", "conflict", "waived"],
    cleared: ["conflict", "waived"],
    conflict: ["cleared", "waived"],
    waived: ["cleared", "conflict"],
  },
  initial: ["pending"],
});
