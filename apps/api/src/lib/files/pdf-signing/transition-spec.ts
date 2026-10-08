import { pdfSigningSessions } from "@/api/db/schema";
import { defineTransitions } from "@/api/lib/db/transitions";

export const PDF_SIGNING_SESSION_TRANSITIONS = defineTransitions(
  pdfSigningSessions,
  { open: ["finalized", "cancelled"], finalized: [], cancelled: [] },
  { terminal: ["finalized", "cancelled"] },
);
