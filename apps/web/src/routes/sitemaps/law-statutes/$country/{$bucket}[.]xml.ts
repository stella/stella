import { createFileRoute } from "@tanstack/react-router";

import {
  createPublicStatuteSitemapXml,
  fetchPublicStatuteSitemapWorks,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/features/statutes/statute-sitemap";
import { isPublicLawSitemapEnabled } from "@/lib/public-law-launch";
import { createSitemapReadFailureResponse } from "@/lib/public-sitemap";
import { isPublicStatutePageCountry } from "@/lib/statutes/statute-route";

export const Route = createFileRoute(
  "/sitemaps/law-statutes/$country/{$bucket}.xml",
)({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (
          !isPublicLawSitemapEnabled() ||
          !isPublicStatutePageCountry(params.country)
        ) {
          return new Response("Not Found", { status: 404 });
        }

        const works = await fetchPublicStatuteSitemapWorks({ shard: params });

        return works.isErr()
          ? createSitemapReadFailureResponse(works.error)
          : new Response(createPublicStatuteSitemapXml(works.value), {
              headers: SITEMAP_XML_RESPONSE_HEADERS,
            });
      },
    },
  },
});
