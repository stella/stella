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

/** Only the public searches, which the corpus admission queue answers for. */
const PUBLIC_CORPUS_SEARCH_PATHS: ReadonlySet<string> = new Set([
  "/v1/case/decisions/search",
  "/v1/legislation/corpus/search",
]);

type WithCorpusRetryAfterOptions = {
  path: string;
  response: Response;
  waitMs: number;
};

/**
 * Says when a public corpus search refused with a 503 is worth asking again,
 * from the wait expected for a search slot. A header the answer already has
 * is kept.
 */
export const withCorpusRetryAfter = ({
  path,
  response,
  waitMs,
}: WithCorpusRetryAfterOptions): Response =>
  response.status === SERVICE_UNAVAILABLE_STATUS &&
  PUBLIC_CORPUS_SEARCH_PATHS.has(path)
    ? setResponseHeaders(
        response,
        { "Retry-After": String(retryAfterSeconds(waitMs)) },
        { overwrite: false },
      )
    : response;

/**
 * A pipeline stage, not route middleware: a route's middleware reads as a gate
 * the capability path would skip, and this one only adds a header. These routes
 * stay synchronous: the header is all a refused caller gets.
 */
export const corpusRetryAfter: Middleware = async (ctx, inner) =>
  withCorpusRetryAfter({
    path: ctx.path,
    response: await inner(),
    waitMs: estimatedCorpusSearchWaitMs(),
  });
