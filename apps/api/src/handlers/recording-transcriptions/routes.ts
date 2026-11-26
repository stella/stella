import createRecordingTranscriptionRun from "@/api/handlers/recording-transcriptions/runs/create";
import readRecordingTranscriptionRun from "@/api/handlers/recording-transcriptions/runs/get";
import { routes } from "@/api/http/route";

export const recordingTranscriptionsRoute = routes(
  {
    "/runs": { POST: createRecordingTranscriptionRun },
    "/runs/:runId": { GET: readRecordingTranscriptionRun },
  },
  { prefix: "/workspaces/:workspaceId/recording-transcriptions" },
);
