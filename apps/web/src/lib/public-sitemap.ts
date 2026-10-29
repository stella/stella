import { TaggedError } from "better-result";

import { ClientOperationError } from "@/lib/errors/client";
import { ssrCacheClassHeaders } from "@/route-response-policy";

const SITEMAP_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400";
const SITEMAP_XML_MAX_BYTES = 50 * 1024 * 1024;

export const TOOLS_SITEMAP_PATH = "/sitemaps/tools.xml";

export const SITEMAP_XML_RESPONSE_HEADERS = {
  ...ssrCacheClassHeaders("public-anonymous"),
  "Cache-Control": SITEMAP_CACHE_CONTROL,
  "Content-Type": "application/xml; charset=utf-8",
} as const;

const SITEMAP_DEFAULT_RETRY_AFTER_SECONDS = "60";

/** The API refused a sitemap read for its request budget; worth retrying later. */
export class SitemapUpstreamBusyError extends TaggedError(
  "SitemapUpstreamBusyError",
)<{
  action: string;
  message: string;
  retryAfter: string;
}> {}

export const createSitemapUpstreamBusyError = ({
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

const createSitemapBusyResponse = (error: SitemapUpstreamBusyError): Response =>
  new Response("Service Unavailable", {
    headers: { "Retry-After": error.retryAfter },
    status: 503,
  });

/**
 * An unreadable sitemap answers a retryable status rather than an empty
 * document: a crawler retries the former and caches the latter as the truth.
 */
export const createSitemapReadFailureResponse = (error: unknown): Response =>
  SitemapUpstreamBusyError.is(error)
    ? createSitemapBusyResponse(error)
    : new Response("Service Unavailable", { status: 503 });

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
