import { env } from "@/env";

// Knowledge readable without an account. Off by default: every Knowledge page
// then requires a signed-in organization, as it always has. The gate resolves
// identically on server and client (env only) because catalogue pages are
// server-rendered.
export const isPublicKnowledgeEnabled = (): boolean =>
  env.VITE_PUBLIC_KNOWLEDGE_ENABLED;

// Sitemap XML serving for the Knowledge catalogue.
export const isPublicKnowledgeSitemapEnabled = (): boolean =>
  env.VITE_PUBLIC_KNOWLEDGE_ENABLED &&
  env.VITE_PUBLIC_KNOWLEDGE_INDEXING_ENABLED;

// Crawl permission additionally requires the deployment to be indexable.
export const isPublicKnowledgeCrawlAllowed = (): boolean =>
  isPublicKnowledgeSitemapEnabled() && env.VITE_SEO_INDEXABLE;
