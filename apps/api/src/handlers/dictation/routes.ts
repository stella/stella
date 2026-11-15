import { routes } from "@/api/http/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import cleanup from "./cleanup";
import {
  readDesktopDictationModels,
  transcribeDesktopDictation,
} from "./desktop-transcription";
import transcribe from "./transcribe";

export const dictationRoute = routes(
  { "/transcribe": { POST: transcribe } },
  { prefix: "/dictation" },
);

/** The linked desktop authenticates with its account key and device proof,
 *  so these routes sit with the other desktop routes, not under a session. */
export const desktopDictationRoute = routes(
  {
    "/cleanup": { POST: cleanup },
    "/models": { GET: readDesktopDictationModels },
    "/transcribe": { POST: transcribeDesktopDictation },
  },
  {
    prefix: "/v1/desktop/dictation",
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
