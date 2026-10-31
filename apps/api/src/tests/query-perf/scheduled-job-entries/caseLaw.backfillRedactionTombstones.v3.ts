import { BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK } from "@/api/lib/scheduler/tasks/case-law-redaction-tombstone-backfill";

import type { ScheduledJobMeasurement } from "../measurement-definition";
import { redactionTombstonePageCompleted } from "../redaction-tombstone-seed";

export default {
  // Imported, not spelled: the gate's CI scope follows this module's imports.
  task: BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
  executed: redactionTombstonePageCompleted,
  scenarios: (["repair", "inline-raw", "settled"] as const).map((cohort) => ({
    size: { type: "redaction-tombstones", rows: 60_000, cohort },
    double: { type: "redaction-tombstones", rows: 120_000, cohort },
  })),
} as const satisfies ScheduledJobMeasurement;
