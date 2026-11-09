import { setResponseHeaders } from "@/api/http/headers";
import type { Middleware } from "@/api/http/route";
import { estimatedCorpusSearchWaitMs } from "@/api/lib/legal-search/corpus-index-client";

const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 30;
const SERVICE_UNAVAILABLE_STATUS = 503;

const retryAfterSeconds = (waitMs: number): number =>
  Math.min(
    MAX_RETRY_AFTER_SECONDS,
    Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil(waitMs / 1000)),
  );

/**
 * Says when a public corpus read refused with a 503 is worth asking again,
 * from the wait expected for a search slot. A header the answer already has
 * is kept.
 */
export const withCorpusRetryAfter = (
  response: Response,
  waitMs: number,
): Response =>
  response.status === SERVICE_UNAVAILABLE_STATUS
    ? setResponseHeaders(
        response,
        { "Retry-After": String(retryAfterSeconds(waitMs)) },
        { overwrite: false },
      )
    : response;

/** These routes stay synchronous: the header is all a refused caller gets. */
export const corpusRetryAfter: Middleware = async (_ctx, inner) =>
  withCorpusRetryAfter(await inner(), estimatedCorpusSearchWaitMs());
