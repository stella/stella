import { createFileRoute } from "@tanstack/react-router";

import { isPublicLawIndexingEnabled } from "@/lib/public-law-launch";
import {
  createPublicLawSitemapIndexXml,
  fetchPublicSitemapShards,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-law-sitemap";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        if (!isPublicLawIndexingEnabled()) {
          return new Response(createPublicLawSitemapIndexXml([]), {
            headers: SITEMAP_XML_RESPONSE_HEADERS,
          });
        }

        return new Response(
          createPublicLawSitemapIndexXml(await fetchPublicSitemapShards()),
          { headers: SITEMAP_XML_RESPONSE_HEADERS },
        );
      },
    },
  },
});
