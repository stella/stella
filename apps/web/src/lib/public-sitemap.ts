import { panic, TaggedError } from "better-result";

import { ClientOperationError } from "@/lib/errors/client";
import { ssrCacheClassHeaders } from "@/route-response-policy";

/**
 * A cached sitemap may also be served for a day after its origin starts
 * failing, the same staleness `stale-while-revalidate` already accepts: a
 * crawler that meets an unreadable file is shown the last good copy rather
 * than an error. A failure itself is answered fresh and never cached, so the
 * copy is replaced as soon as the file reads again.
 */
const SITEMAP_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400, stale-if-error=86400";
const SITEMAP_XML_MAX_BYTES = 50 * 1024 * 1024;

export const TOOLS_SITEMAP_PATH = "/sitemaps/tools.xml";

export const SITEMAP_XML_RESPONSE_HEADERS = {
  ...ssrCacheClassHeaders("public-anonymous"),
  "Cache-Control": SITEMAP_CACHE_CONTROL,
  "Content-Type": "application/xml; charset=utf-8",
} as const;

const SITEMAP_DEFAULT_RETRY_AFTER_SECONDS = "60";

const SITEMAP_UPSTREAM_BUSY_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/**
 * The API's answers for a sitemap address it does not hold: an unknown shard,
 * or parameters it refuses as invalid.
 */
const SITEMAP_UPSTREAM_MISSING_STATUSES: ReadonlySet<number> = new Set([
  400, 404, 410, 422,
]);

/** The API refused a sitemap read for its request budget; worth retrying later. */
export class SitemapUpstreamBusyError extends TaggedError(
  "SitemapUpstreamBusyError",
)<{
  action: string;
  message: string;
  retryAfter: string;
}> {}

/** The requested sitemap does not exist; a crawler should drop the address. */
export class SitemapNotFoundError extends TaggedError("SitemapNotFoundError")<{
  action: string;
  message: string;
}> {}

type SitemapReadFailureReason =
  | "unexpected_error"
  | "unexpected_payload"
  | "upstream_status"
  | "upstream_unreachable";

/** Any other unreadable sitemap: a fault, answered with a retryable status. */
export class SitemapReadFailedError extends TaggedError(
  "SitemapReadFailedError",
)<{
  action: string;
  cause?: unknown;
  errorName?: string;
  message: string;
  reason: SitemapReadFailureReason;
  upstreamStatus: number | null;
}> {}

export type SitemapReadFailure =
  SitemapNotFoundError | SitemapReadFailedError | SitemapUpstreamBusyError;

const createSitemapUpstreamBusyError = ({
  action,
  response,
}: {
  action: string;
  response: Response;
}): SitemapUpstreamBusyError => {
  const seconds = Number(response.headers.get("Retry-After"));

  return new SitemapUpstreamBusyError({
    action,
    message: "The public sitemap source is over its request budget.",
    retryAfter:
      Number.isSafeInteger(seconds) && seconds > 0
        ? String(seconds)
        : SITEMAP_DEFAULT_RETRY_AFTER_SECONDS,
  });
};

/**
 * Classifies a non-OK answer from the sitemap API. Only a read that addresses
 * one shard from the request path can be missing; the shard lists behind the
 * sitemap index always exist, so a refusal there is a fault.
 */
export const classifySitemapUpstreamFailure = ({
  action,
  addressesShard,
  response,
}: {
  action: string;
  addressesShard: boolean;
  response: Response;
}): SitemapReadFailure => {
  if (SITEMAP_UPSTREAM_BUSY_STATUSES.has(response.status)) {
    return createSitemapUpstreamBusyError({ action, response });
  }

  if (
    addressesShard &&
    SITEMAP_UPSTREAM_MISSING_STATUSES.has(response.status)
  ) {
    return new SitemapNotFoundError({
      action,
      message: "The public sitemap source holds no such shard.",
    });
  }

  return new SitemapReadFailedError({
    action,
    message: `The public sitemap source answered ${response.status}.`,
    reason: "upstream_status",
    upstreamStatus: response.status,
  });
};

const toSitemapReadFailure = (error: unknown): SitemapReadFailure => {
  if (
    SitemapUpstreamBusyError.is(error) ||
    SitemapNotFoundError.is(error) ||
    SitemapReadFailedError.is(error)
  ) {
    return error;
  }

  return new SitemapReadFailedError({
    action: "readPublicSitemap",
    cause: error,
    ...(error instanceof Error && { errorName: error.name }),
    message: "The public sitemap could not be read.",
    reason: "unexpected_error",
    upstreamStatus: null,
  });
};

/**
 * A busy refusal is a deliberate 503, indistinguishable from a fault in the
 * load balancer's counts. One line per refusal lets them be told apart.
 */
const createSitemapBusyResponse = (
  error: SitemapUpstreamBusyError,
): Response => {
  process.stdout.write(
    `${JSON.stringify({ message: "web.sitemap.busy_refusal" })}\n`,
  );
  return new Response("Service Unavailable", {
    headers: { "Retry-After": error.retryAfter },
    status: 503,
  });
};

/**
 * Every other unreadable sitemap still counts as a fault; one line names its
 * kind and upstream status, never the address or the request.
 */
const createSitemapReadFailedResponse = (
  error: SitemapReadFailedError,
): Response => {
  process.stdout.write(
    `${JSON.stringify({
      action: error.action,
      ...(error.errorName !== undefined && { errorName: error.errorName }),
      message: "web.sitemap.read_failed",
      reason: error.reason,
      upstreamStatus: error.upstreamStatus,
    })}\n`,
  );
  return new Response("Service Unavailable", { status: 503 });
};

/**
 * An unreadable sitemap answers a retryable status rather than an empty
 * document: a crawler retries the former and caches the latter as the truth.
 * A sitemap the API does not hold answers 404, so the address is dropped.
 */
export const createSitemapReadFailureResponse = (error: unknown): Response => {
  const failure = toSitemapReadFailure(error);
  switch (failure._tag) {
    case "SitemapUpstreamBusyError": {
      return createSitemapBusyResponse(failure);
    }
    case "SitemapNotFoundError": {
      return new Response("Not Found", { status: 404 });
    }
    case "SitemapReadFailedError": {
      return createSitemapReadFailedResponse(failure);
    }
    default: {
      failure satisfies never;
      return panic("Unhandled sitemap read failure.");
    }
  }
};

export const escapeSitemapXml = (value: string): string =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");

export const assertSitemapXmlWithinProtocolLimits = (
  xml: string,
  maxBytes = SITEMAP_XML_MAX_BYTES,
): void => {
  const byteLength = new TextEncoder().encode(xml).byteLength;
  if (byteLength <= maxBytes) {
    return;
  }

  throw new ClientOperationError({
    action: "serializePublicSitemap",
    message: `Public sitemap exceeded ${maxBytes} bytes.`,
  });
};
