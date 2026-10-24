import { createFileRoute } from "@tanstack/react-router";
import { Result } from "better-result";

import { publicCaseLawPageCountryFromParam } from "@/features/case-law/case-law-jurisdiction";
import { isPublicLawSitemapEnabled } from "@/lib/public-law-launch";
import {
  createPublicCaseLawSitemapXml,
  fetchPublicSitemapDecisions,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-law-sitemap";
import { createSitemapReadFailureResponse } from "@/lib/public-sitemap";

export const Route = createFileRoute(
  "/sitemaps/law-cases/$country/$year/{$month}.xml",
)({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (
          !isPublicLawSitemapEnabled() ||
          publicCaseLawPageCountryFromParam(params.country) === null
        ) {
          return new Response("Not Found", { status: 404 });
        }

        const decisions = await Result.tryPromise(
          async () =>
            await fetchPublicSitemapDecisions({
              shard: { ...params, bucket: "all" },
            }),
        );

        return decisions.isErr()
          ? createSitemapReadFailureResponse(decisions.error.cause)
          : new Response(createPublicCaseLawSitemapXml(decisions.value), {
              headers: SITEMAP_XML_RESPONSE_HEADERS,
            });
      },
    },
  },
});
