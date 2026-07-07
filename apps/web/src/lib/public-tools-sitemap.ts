import { loadCatalogue } from "@stll/catalogue";

import {
  assertPublicLawSitemapXmlWithinProtocolLimits,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-law-sitemap";
import { isPublicToolsSitemapEnabled } from "@/lib/public-tools-launch";
import { createPublicToolsCanonicalUrl } from "@/lib/public-tools-seo";

export const TOOLS_SITEMAP_PATH = "/sitemaps/tools.xml";

export { SITEMAP_XML_RESPONSE_HEADERS };

type PublicToolsSitemapOptions = {
  publicToolsIndexingEnabled?: boolean;
};

const xmlEscape = (value: string): string =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");

// Static browse surfaces plus every catalogue entry. Content is fully
// static (the generated `@stll/catalogue` bundle), so the whole set is
// enumerable in one file without pagination.
const collectToolPaths = (): readonly `/${string}`[] => [
  "/tools",
  "/tools/contribute",
  ...loadCatalogue().map((entry): `/${string}` => `/tools/${entry.slug}`),
];

export const createPublicToolsSitemapXml = ({
  publicToolsIndexingEnabled = isPublicToolsSitemapEnabled(),
}: PublicToolsSitemapOptions = {}): string => {
  if (!publicToolsIndexingEnabled) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>
`;
  }

  const entries = collectToolPaths()
    .map(
      (path) => `  <url>
    <loc>${xmlEscape(createPublicToolsCanonicalUrl(path))}</loc>
  </url>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;

  assertPublicLawSitemapXmlWithinProtocolLimits(xml);

  return xml;
};
