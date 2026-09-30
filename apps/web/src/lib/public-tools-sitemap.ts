import { publicToolsBasePath } from "@/lib/knowledge/public-tools-path";
import { publicToolCrawlPaths } from "@/lib/public-crawl-policy";
import {
  assertSitemapXmlWithinProtocolLimits,
  escapeSitemapXml,
  SITEMAP_XML_RESPONSE_HEADERS,
  TOOLS_SITEMAP_PATH,
} from "@/lib/public-sitemap";
import { isPublicToolsSitemapEnabled } from "@/lib/public-tools-launch";
import { createPublicToolsCanonicalUrl } from "@/lib/public-tools-seo";

export { SITEMAP_XML_RESPONSE_HEADERS, TOOLS_SITEMAP_PATH };

type PublicToolsSitemapOptions = {
  publicToolsIndexingEnabled?: boolean;
};

export const createPublicToolsSitemapXml = ({
  publicToolsIndexingEnabled = isPublicToolsSitemapEnabled(),
}: PublicToolsSitemapOptions = {}): string => {
  if (!publicToolsIndexingEnabled) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>
`;
  }

  const entries = publicToolCrawlPaths(publicToolsBasePath())
    .map(
      (path) => `  <url>
    <loc>${escapeSitemapXml(createPublicToolsCanonicalUrl(path))}</loc>
  </url>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;

  assertSitemapXmlWithinProtocolLimits(xml);

  return xml;
};
