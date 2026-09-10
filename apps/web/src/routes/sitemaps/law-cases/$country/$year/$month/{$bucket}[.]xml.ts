import { createFileRoute } from "@tanstack/react-router";

import { publicCaseLawCountryFromParam } from "@/features/case-law/case-law-jurisdiction";
import { isPublicLawSitemapEnabled } from "@/lib/public-law-launch";
import {
  createPublicCaseLawSitemapXml,
  fetchPublicSitemapDecisions,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-law-sitemap";

export const Route = createFileRoute(
  "/sitemaps/law-cases/$country/$year/$month/{$bucket}.xml",
)({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (
          !isPublicLawSitemapEnabled() ||
          publicCaseLawCountryFromParam(params.country) === null
        ) {
          return new Response("Not Found", { status: 404 });
        }

        return new Response(
          createPublicCaseLawSitemapXml(
            await fetchPublicSitemapDecisions({ shard: params }),
          ),
          { headers: SITEMAP_XML_RESPONSE_HEADERS },
        );
      },
    },
  },
});
