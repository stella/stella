import { routes } from "@/api/http/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import cleanup from "./cleanup";
import { saveDesktopDictationTranscript } from "./desktop-transcript";
import {
  readDesktopDictationModels,
  transcribeDesktopDictation,
} from "./desktop-transcription";
import changeLearnedFixes from "./learned-fixes/change";
import clearLearnedFixes from "./learned-fixes/clear";
import {
  changeDesktopLearnedFixes,
  clearDesktopLearnedFixes,
  listDesktopLearnedFixes,
} from "./learned-fixes/desktop";
import listLearnedFixes from "./learned-fixes/list";
import memberCleanup from "./member-cleanup";
import memberRecordingCleanup from "./member-recording-cleanup";
import models from "./models";
import recordingCleanup from "./recording-cleanup";
import transcribe from "./transcribe";

export const dictationRoute = routes(
  {
    "/cleanup": { POST: memberCleanup },
    "/learned-fixes": {
      GET: listLearnedFixes,
      POST: changeLearnedFixes,
      DELETE: clearLearnedFixes,
    },
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
    "/learned-fixes": {
      GET: listDesktopLearnedFixes,
      POST: changeDesktopLearnedFixes,
      DELETE: clearDesktopLearnedFixes,
    },
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
