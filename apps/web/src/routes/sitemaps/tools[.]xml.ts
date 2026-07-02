import { createFileRoute } from "@tanstack/react-router";

import {
  createPublicToolsSitemapXml,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-tools-sitemap";

export const Route = createFileRoute("/sitemaps/tools.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(createPublicToolsSitemapXml(), {
          headers: SITEMAP_XML_RESPONSE_HEADERS,
        }),
    },
  },
});
