import { createFileRoute } from "@tanstack/react-router";

import { isPublicLawIndexingEnabled } from "@/lib/public-law-launch";
import {
  createPublicLawStaticSitemapXml,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-law-sitemap";

export const Route = createFileRoute("/sitemaps/law.xml")({
  server: {
    handlers: {
      GET: () => {
        if (!isPublicLawIndexingEnabled()) {
          return new Response("Not Found", { status: 404 });
        }

        return new Response(createPublicLawStaticSitemapXml(), {
          headers: SITEMAP_XML_RESPONSE_HEADERS,
        });
      },
    },
  },
});
