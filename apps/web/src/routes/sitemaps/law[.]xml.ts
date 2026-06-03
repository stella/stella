import { createFileRoute } from "@tanstack/react-router";

import {
  createPublicLawStaticSitemapXml,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-law-sitemap";

export const Route = createFileRoute("/sitemaps/law.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(createPublicLawStaticSitemapXml(), {
          headers: SITEMAP_XML_RESPONSE_HEADERS,
        }),
    },
  },
});
