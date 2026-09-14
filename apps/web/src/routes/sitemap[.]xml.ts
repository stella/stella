import { createFileRoute } from "@tanstack/react-router";

import { fetchPublicStatuteSitemapShards } from "@/features/statutes/statute-sitemap";
import { isPublicLawSitemapEnabled } from "@/lib/public-law-launch";
import {
  createPublicLawSitemapIndexXml,
  fetchPublicSitemapShards,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-law-sitemap";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        if (!isPublicLawSitemapEnabled()) {
          return new Response(createPublicLawSitemapIndexXml([]), {
            headers: SITEMAP_XML_RESPONSE_HEADERS,
          });
        }

        const [shards, statuteShards] = await Promise.all([
          fetchPublicSitemapShards(),
          fetchPublicStatuteSitemapShards(),
        ]);

        // An index missing a whole shard family is worse than no answer: it
        // would tell a crawler those URLs no longer exist.
        if (statuteShards.isErr()) {
          return new Response("Service Unavailable", { status: 503 });
        }

        return new Response(
          createPublicLawSitemapIndexXml(shards, {
            statuteShards: statuteShards.value,
          }),
          { headers: SITEMAP_XML_RESPONSE_HEADERS },
        );
      },
    },
  },
});
