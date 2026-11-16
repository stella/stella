import { organizationDataExports } from "@/api/db/schema";
import { defineTransitions } from "@/api/lib/db/transitions";

// An export is claimed (queued -> running), finishes (ready) or fails, and a
// stopped run is handed back (running -> queued) to resume. Every move is
// fenced on `attempt`, which each claim advances, so a superseded run's
// writes match nothing.
export const DATA_EXPORT_TRANSITIONS = defineTransitions(
  organizationDataExports,
  {
    queued: ["running", "failed"],
    running: ["ready", "failed", "queued"],
    ready: ["expired"],
    failed: [],
    expired: [],
  },
  { terminal: ["failed", "expired"], fence: "attempt" },
);
