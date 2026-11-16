import { createFileRoute } from "@tanstack/react-router";
import { Result } from "better-result";

import { fetchPublicStatuteSitemapShards } from "@/features/statutes/statute-sitemap";
import { isPublicLawSitemapEnabled } from "@/lib/public-law-launch";
import {
  createPublicLawSitemapIndexXml,
  fetchPublicSitemapShards,
  SITEMAP_XML_RESPONSE_HEADERS,
} from "@/lib/public-law-sitemap";
import {
  createSitemapReadFailureResponse,
  SitemapUpstreamBusyError,
} from "@/lib/public-sitemap";

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
    if (shards.isOk() && statuteShards.isOk()) {
      return new Response(
        createPublicLawSitemapIndexXml(shards.value, {
          statuteShards: statuteShards.value,
        }),
        { headers: SITEMAP_XML_RESPONSE_HEADERS },
      );
    }

    const caseLawError = shards.isErr() ? shards.error.cause : undefined;
    const statuteError = statuteShards.isErr()
      ? statuteShards.error
      : undefined;
    const preferredError = SitemapUpstreamBusyError.is(statuteError)
      ? statuteError
      : (caseLawError ?? statuteError);
    return createSitemapReadFailureResponse(preferredError);
  },
});

export const sitemapHandlers = createSitemapHandlers();

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: sitemapHandlers,
  },
});
