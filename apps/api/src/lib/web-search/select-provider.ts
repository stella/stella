import { env } from "@/api/env";
import { createJinaFetcher } from "@/api/lib/web-search/jina";
import { createTavilyProvider } from "@/api/lib/web-search/tavily";
import type { UrlFetcher, WebSearchProvider } from "@/api/lib/web-search/types";

let webSearchProviderSingleton: WebSearchProvider | null | undefined;
let urlFetcherSingleton: UrlFetcher | null | undefined;

/**
 * Returns the configured web-search provider, or null when the deploy
 * has not supplied the credentials required by `WEB_SEARCH_PROVIDER`.
 * Callers must treat a null return as "feature unavailable" and skip
 * tool registration; never assume a default provider.
 */
const buildWebSearchProvider = (): WebSearchProvider | null => {
  if (env.WEB_SEARCH_PROVIDER === "tavily") {
    const apiKey = env.TAVILY_API_KEY;
    return apiKey ? createTavilyProvider({ apiKey }) : null;
  }
  return null;
};

const buildUrlFetcher = (): UrlFetcher | null => {
  if (env.WEB_FETCH_PROVIDER === "jina") {
    return createJinaFetcher({ apiKey: env.JINA_API_KEY });
  }
  return null;
};

export const getWebSearchProvider = (): WebSearchProvider | null => {
  if (webSearchProviderSingleton === undefined) {
    webSearchProviderSingleton = buildWebSearchProvider();
  }
  return webSearchProviderSingleton;
};

export const isWebSearchDeployAvailable = (): boolean =>
  env.FEATURE_WEB_SEARCH && getWebSearchProvider() !== null;

export const getUrlFetcher = (): UrlFetcher | null => {
  if (urlFetcherSingleton === undefined) {
    urlFetcherSingleton = buildUrlFetcher();
  }
  return urlFetcherSingleton;
};
