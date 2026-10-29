import { createFileRoute } from "@tanstack/react-router";
import { Result } from "better-result";

import { fetchPublicStatuteSitemapShards } from "@/features/statutes/statute-sitemap";
import { isPublicLawSitemapEnabled } from "@/lib/public-law-launch";
import {
  createPublicLawSitemapIndexXml,
  fetchPublicSitemapShards,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-law-sitemap";
import { createSitemapReadFailureResponse } from "@/lib/public-sitemap";

type SitemapHandlersOptions = {
  isEnabled?: () => boolean;
  fetchImpl?: NonNullable<
    Parameters<typeof fetchPublicSitemapShards>[0]
  >["fetchImpl"];
};

export const createSitemapHandlers = ({
  isEnabled = isPublicLawSitemapEnabled,
  fetchImpl = fetch,
}: SitemapHandlersOptions = {}) => ({
  GET: async () => {
    if (!isEnabled()) {
      return new Response(createPublicLawSitemapIndexXml([]), {
        headers: SITEMAP_XML_RESPONSE_HEADERS,
      });
    }

    const [shards, statuteShards] = await Promise.all([
      Result.tryPromise(
        async () => await fetchPublicSitemapShards({ fetchImpl }),
      ),
      fetchPublicStatuteSitemapShards({ fetchImpl }),
    ]);

    // An index missing a whole shard family is worse than no answer: it
    // would tell a crawler those URLs no longer exist.
    if (shards.isErr()) {
      return createSitemapReadFailureResponse(shards.error.cause);
    }
    if (statuteShards.isErr()) {
      return createSitemapReadFailureResponse(statuteShards.error);
    }

    return new Response(
      createPublicLawSitemapIndexXml(shards.value, {
        statuteShards: statuteShards.value,
      }),
      { headers: SITEMAP_XML_RESPONSE_HEADERS },
    );
  },
});

export const sitemapHandlers = createSitemapHandlers();

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: sitemapHandlers,
  },
});
