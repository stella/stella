import { ClientOperationError } from "@/lib/errors/client";

const SITEMAP_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400";
const SITEMAP_XML_MAX_BYTES = 50 * 1024 * 1024;

export const TOOLS_SITEMAP_PATH = "/sitemaps/tools.xml";

export const SITEMAP_XML_RESPONSE_HEADERS = {
  "Cache-Control": SITEMAP_CACHE_CONTROL,
  "Content-Type": "application/xml; charset=utf-8",
} as const;

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
