import { createFileRoute } from "@tanstack/react-router";

import {
  createPublicStatuteSitemapXml,
  fetchPublicStatuteSitemapWorks,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/features/statutes/statute-sitemap";
import { isPublicLawSitemapEnabled } from "@/lib/public-law-launch";
import { isPublicStatuteCountry } from "@/lib/statute-route";

export const Route = createFileRoute(
  "/sitemaps/law-statutes/$country/{$bucket}.xml",
)({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (
          !isPublicLawSitemapEnabled() ||
          !isPublicStatuteCountry(params.country)
        ) {
          return new Response("Not Found", { status: 404 });
        }

        const works = await fetchPublicStatuteSitemapWorks({ shard: params });

        // An unreadable shard answers 503 rather than an empty urlset: a
        // crawler retries the former and caches the latter as the truth.
        return works.isErr()
          ? new Response("Service Unavailable", { status: 503 })
          : new Response(createPublicStatuteSitemapXml(works.value), {
              headers: SITEMAP_XML_RESPONSE_HEADERS,
            });
      },
    },
  },
});
