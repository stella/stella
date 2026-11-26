import { recordingTranscriptionRuns } from "@/api/db/schema";
import { defineTransitions } from "@/api/lib/db/transitions";

/** A run moves forward through its stages once; any stage may fail, and a
 *  run whose requester is gone is cancelled. */
export const RECORDING_TRANSCRIPTION_TRANSITIONS = defineTransitions(
  recordingTranscriptionRuns,
  {
    queued: ["transcribing", "failed", "cancelled"],
    transcribing: ["saving", "failed", "cancelled"],
    saving: ["completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  },
  { terminal: ["completed", "failed", "cancelled"] },
);
