import { createFileRoute } from "@tanstack/react-router";

import {
  createPublicLawSitemapIndexXml,
  fetchPublicSitemapShards,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-law-sitemap";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () =>
        new Response(
          createPublicLawSitemapIndexXml(await fetchPublicSitemapShards()),
          {
            headers: SITEMAP_XML_RESPONSE_HEADERS,
          },
        ),
    },
  },
});
