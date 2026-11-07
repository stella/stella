import { env } from "@/env";

// Public law is a deployment capability, not a per-browser preview: the
// server render and hydration must build the same navigation tree, so the
// gate reads only build-time configuration. Local development always serves it.
export const isPublicLawEnabled = (): boolean =>
  import.meta.env.DEV || env.VITE_PUBLIC_LAW_ENABLED;

// Sitemap XML serving: a deployment builds and serves the case-law sitemaps
// once the public-law surface is indexing-ready. This keeps today's semantics
// and is independent of whether the deployment is allowed to be crawled, so
// deployments that should not be crawled can still serve sitemaps for
// verification while staying non-indexable.
export const isPublicLawSitemapEnabled = (): boolean =>
  env.VITE_PUBLIC_LAW_ENABLED && env.VITE_PUBLIC_LAW_INDEXING_ENABLED;

// Crawl permission additionally requires the deployment to be marked
// indexable. This gates the meta robots directive and the robots.txt law rule.
export const isPublicLawCrawlAllowed = (): boolean =>
  isPublicLawSitemapEnabled() && env.VITE_SEO_INDEXABLE;
