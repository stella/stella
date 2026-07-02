import { env } from "@/env";
import { betaFeaturesAvailable } from "@/lib/beta-features";

// Beta hosts always serve the /tools routes; the env flag governs
// production. The gate must resolve identically on server and client
// (host + env only, no localStorage) because /tools paths are
// server-rendered and the server cannot see a browser-only toggle.
export const isPublicToolsRouteEnabled = (): boolean =>
  import.meta.env.DEV ||
  env.VITE_PUBLIC_TOOLS_ENABLED ||
  betaFeaturesAvailable();

// Sitemap XML serving: a deployment builds and serves the tools sitemap
// once the public-tools surface is indexing-ready. This is independent of
// whether the deployment is allowed to be crawled, so deployments that
// should not be crawled can still serve sitemaps for verification while
// staying non-indexable.
export const isPublicToolsSitemapEnabled = (): boolean =>
  env.VITE_PUBLIC_TOOLS_ENABLED && env.VITE_PUBLIC_TOOLS_INDEXING_ENABLED;

// Crawl permission additionally requires the deployment to be marked
// indexable. This gates the meta robots directive and the robots.txt
// tools rule.
export const isPublicToolsCrawlAllowed = (): boolean =>
  isPublicToolsSitemapEnabled() && env.VITE_SEO_INDEXABLE;
