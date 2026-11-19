import { DELETE_KEPT_TRANSCRIPTS_TASK } from "@/api/lib/scheduler/tasks/kept-transcript-deletion";

import { measureKeptTranscriptDeletionHistory } from "../kept-transcript-deletion-run";
import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  task: DELETE_KEPT_TRANSCRIPTS_TASK,
  scenarios: [],
  measure: measureKeptTranscriptDeletionHistory,
} as const satisfies ScheduledJobMeasurement;
