import { DESKTOP_DICTATION_CLEANUP_PATH } from "@stll/api-contract/desktop-dictation-cleanup";

import { routes } from "@/api/http/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import cleanup from "./cleanup";
import transcribe from "./transcribe";

export const dictationRoute = routes(
  { "/transcribe": { POST: transcribe } },
  { prefix: "/dictation" },
);

/** The linked desktop authenticates with its account key and device proof,
 *  so this route sits with the other desktop routes, not under a session. */
export const desktopDictationRoute = routes(
  { "/": { POST: cleanup } },
  {
    prefix: DESKTOP_DICTATION_CLEANUP_PATH,
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
