import { routes } from "@/api/http/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import cleanup from "./cleanup";
import { saveDesktopDictationTranscript } from "./desktop-transcript";
import {
  readDesktopDictationModels,
  transcribeDesktopDictation,
} from "./desktop-transcription";
import memberCleanup from "./member-cleanup";
import memberRecordingCleanup from "./member-recording-cleanup";
import models from "./models";
import recordingCleanup from "./recording-cleanup";
import transcribe from "./transcribe";

export const dictationRoute = routes(
  {
    "/cleanup": { POST: memberCleanup },
    "/models": { GET: models },
    "/recording-cleanup": { POST: memberRecordingCleanup },
    "/transcribe": { POST: transcribe },
  },
  { prefix: "/dictation" },
);

/** The linked desktop authenticates with its account key and device proof,
 *  so these routes sit with the other desktop routes, not under a session. */
export const desktopDictationRoute = routes(
  {
    "/cleanup": { POST: cleanup },
    "/models": { GET: readDesktopDictationModels },
    "/recording-cleanup": { POST: recordingCleanup },
    "/transcribe": { POST: transcribeDesktopDictation },
    "/transcripts": { POST: saveDesktopDictationTranscript },
  },
  {
    prefix: "/v1/desktop/dictation",
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
