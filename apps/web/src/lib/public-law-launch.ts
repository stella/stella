import { env } from "@/env";
import { betaFeaturesAvailable } from "@/lib/beta-features";

// Beta hosts always serve the /law routes; the Settings toggle only
// governs discoverability (sidebar entry, search kinds). The gate must
// not depend on the localStorage-backed toggle because /law paths are
// server-rendered and the server cannot see it — host and env flag
// resolve identically on both sides.
export const isPublicLawRouteEnabled = (): boolean =>
  import.meta.env.DEV || env.VITE_PUBLIC_LAW_ENABLED || betaFeaturesAvailable();

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
