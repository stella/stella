import { env } from "@/env";
import { isPublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";
import { betaFeaturesHostDefaultEnabled } from "@/lib/beta-features";
import { previewRouteAvailable } from "@/lib/beta-features.logic";

// Deployment-enabled and beta-host routes resolve during SSR. On other hosts,
// client navigation is available only after this browser opts into the preview;
// a direct server load remains closed because localStorage is intentionally not
// treated as server-visible deployment configuration.
export const isPublicLawRouteEnabled = (): boolean =>
  previewRouteAvailable({
    browserPreviewEnabled: isPublicLawPreviewEnabled(),
    deploymentEnabled: env.VITE_PUBLIC_LAW_ENABLED,
    hostDefaultEnabled: betaFeaturesHostDefaultEnabled(),
  });

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
