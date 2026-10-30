import { workObligations } from "@/api/db/schema";
import { defineKeyedTransitions } from "@/api/lib/db/transitions";

export const WORK_OBLIGATION_TRANSITIONS = defineKeyedTransitions({
  table: workObligations,
  key: "entityId",
  edges: {
    unassigned: [
      "awaiting_acknowledgement",
      "active",
      "completed",
      "cancelled",
    ],
    awaiting_acknowledgement: [
      "unassigned",
      "active",
      "completed",
      "cancelled",
    ],
    active: [
      "unassigned",
      "awaiting_acknowledgement",
      "completed",
      "cancelled",
    ],
    completed: ["unassigned", "awaiting_acknowledgement", "active"],
    cancelled: ["unassigned", "awaiting_acknowledgement", "active"],
  },
  // Closed obligations can reopen according to their current ownership state.
  options: { terminal: [] },
});
