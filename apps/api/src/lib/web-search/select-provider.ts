import { env } from "@/api/env";
import { createJinaFetcher } from "@/api/lib/web-search/jina";
import { createTavilyProvider } from "@/api/lib/web-search/tavily";
import type { UrlFetcher, WebSearchProvider } from "@/api/lib/web-search/types";

/**
 * Per-organization BYOK web-search credentials. Either value may be
 * absent; resolution falls back to the platform's deploy-level env
 * key (and Jina works keyless, so its key is purely a rate-limit
 * elevation).
 */
export type WebSearchKeys = {
  searchApiKey?: string | null | undefined;
  fetchApiKey?: string | null | undefined;
};

export type ResolvedWebSearchProviders = {
  webSearchProvider: WebSearchProvider | null;
  urlFetcher: UrlFetcher | null;
};

/**
 * Platform deploy configuration for web search. Passed explicitly so
 * the resolver stays pure and unit-testable; `webSearchDeployConfigFromEnv`
 * supplies the live values.
 */
export type WebSearchDeployConfig = {
  featureEnabled: boolean;
  searchProvider: "tavily" | undefined;
  fetchProvider: "jina" | undefined;
  platformSearchApiKey: string | undefined;
  platformFetchApiKey: string | undefined;
};

/**
 * Resolve the web-search + url-fetch providers for one organization.
 *
 * The org's BYOK key wins; the platform key is the shared fallback.
 * The provider selector still decides which implementation runs, so a
 * deploy that wants BYOK-only sets `WEB_SEARCH_PROVIDER` (and
 * `WEB_FETCH_PROVIDER`) while leaving its own keys unset. A null
 * provider means "feature unavailable for this org"; callers must skip
 * tool registration rather than assume a default.
 */
export const resolveWebSearchProviders = (
  deploy: WebSearchDeployConfig,
  keys?: WebSearchKeys,
): ResolvedWebSearchProviders => {
  if (!deploy.featureEnabled) {
    return { webSearchProvider: null, urlFetcher: null };
  }

  const searchApiKey = keys?.searchApiKey || deploy.platformSearchApiKey;
  const webSearchProvider =
    deploy.searchProvider === "tavily" && searchApiKey
      ? createTavilyProvider({ apiKey: searchApiKey })
      : null;

  const fetchApiKey = keys?.fetchApiKey || deploy.platformFetchApiKey;
  const urlFetcher =
    deploy.fetchProvider === "jina"
      ? createJinaFetcher({ apiKey: fetchApiKey || undefined })
      : null;

  return { webSearchProvider, urlFetcher };
};

export const webSearchDeployConfigFromEnv = (): WebSearchDeployConfig => ({
  featureEnabled: env.FEATURE_WEB_SEARCH,
  searchProvider: env.WEB_SEARCH_PROVIDER,
  fetchProvider: env.WEB_FETCH_PROVIDER,
  platformSearchApiKey: env.TAVILY_API_KEY,
  platformFetchApiKey: env.JINA_API_KEY,
});

export const resolveWebSearchProvidersFromEnv = (
  keys?: WebSearchKeys,
): ResolvedWebSearchProviders =>
  resolveWebSearchProviders(webSearchDeployConfigFromEnv(), keys);
