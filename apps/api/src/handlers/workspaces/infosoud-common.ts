import { t } from "elysia";

import {
  InfoSoudAPIError,
  InfoSoudClient,
  InfoSoudParseError,
  InfoSoudPragueCourtResolutionError,
  InfoSoudRequestError,
} from "@stll/infosoud";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const infosoudLookupBodySchema = t.Object({
  courtCode: t.String({ minLength: 1, maxLength: 16 }),
  spisZn: t.String({ minLength: 1, maxLength: 64 }),
});

let sharedClient: InfoSoudClient | undefined;

/**
 * One process-wide InfoSoud client, created lazily on first use.
 *
 * A single instance is required for the client's politeness throttle to pace
 * concurrent callers, since the throttle is per-instance; a per-request client
 * would defeat it. Caching is enabled only for the courts list (its default
 * 24h TTL), which is identical for every workspace and rarely changes.
 * Per-case reads keep a 0ms TTL so lookups and the tracked-case sync always
 * see live registry data.
 */
export const getInfoSoudClient = (): InfoSoudClient => {
  sharedClient ??= new InfoSoudClient({
    cache: {
      caseTtlMs: 0,
      eventDetailTtlMs: 0,
      hearingsTtlMs: 0,
    },
  });
  return sharedClient;
};

export const toInfoSoudLookupError = (error: unknown): HandlerError => {
  if (error instanceof InfoSoudParseError) {
    return new HandlerError({
      status: 400,
      message: error.message,
      cause: error,
    });
  }

  if (error instanceof InfoSoudAPIError) {
    return new HandlerError({
      status: error.status === 400 ? 404 : 502,
      message:
        error.status === 400
          ? "InfoSoud case not found"
          : "InfoSoud returned an error",
      cause: error,
    });
  }

  if (error instanceof InfoSoudPragueCourtResolutionError) {
    return new HandlerError({
      status: 404,
      message: "InfoSoud case not found",
      cause: error,
    });
  }

  if (error instanceof InfoSoudRequestError) {
    return new HandlerError({
      status: 502,
      message: "InfoSoud request failed",
      cause: error,
    });
  }

  return new HandlerError({
    status: 500,
    message: "InfoSoud lookup failed",
    cause: error,
  });
};
