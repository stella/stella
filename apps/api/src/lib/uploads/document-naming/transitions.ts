import { documentNamingRuns } from "@/api/db/schema";
import { defineTransitions } from "@/api/lib/db/transitions";

/**
 * A run is claimed from `pending`, and goes back there when its lease lapses
 * or the period's model budget is spent. It settles once, fenced on `attempt`.
 */
export const DOCUMENT_NAMING_TRANSITIONS = defineTransitions(
  documentNamingRuns,
  {
    pending: ["running", "cancelled"],
    running: ["pending", "succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
  },
  { terminal: ["succeeded", "failed", "cancelled"], fence: "attempt" },
);
