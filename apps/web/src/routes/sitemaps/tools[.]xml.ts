import { createFileRoute } from "@tanstack/react-router";

import { isPublicToolsSitemapEnabled } from "@/lib/public-tools-launch";
import {
  createPublicToolsSitemapXml,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-tools-sitemap";

export const Route = createFileRoute("/sitemaps/tools.xml")({
  server: {
    handlers: {
      GET: () => {
        if (!isPublicToolsSitemapEnabled()) {
          return new Response("Not Found", { status: 404 });
        }

        return new Response(createPublicToolsSitemapXml(), {
          headers: SITEMAP_XML_RESPONSE_HEADERS,
        });
      },
    },
  },
});
