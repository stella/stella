import { TaggedError } from "better-result";
import * as v from "valibot";

export const WEB_SEARCH_JURISDICTIONS = [
  "cz",
  "sk",
  "de",
  "at",
  "eu",
  "global",
] as const;

export type WebSearchJurisdiction = (typeof WEB_SEARCH_JURISDICTIONS)[number];

export const WEB_SEARCH_FRESHNESS = [
  "day",
  "week",
  "month",
  "year",
  "any",
] as const;

export type WebSearchFreshness = (typeof WEB_SEARCH_FRESHNESS)[number];

export const WEB_SEARCH_PROVIDER_NAMES = ["tavily"] as const;
export const URL_FETCHER_NAMES = ["jina"] as const;

export type WebSearchProviderName = (typeof WEB_SEARCH_PROVIDER_NAMES)[number];
export type UrlFetcherName = (typeof URL_FETCHER_NAMES)[number];

export const webSearchResultSchema = v.strictObject({
  id: v.string(),
  url: v.pipe(v.string(), v.url()),
  title: v.string(),
  snippet: v.string(),
  publishedAt: v.optional(v.string()),
  source: v.string(),
  score: v.optional(v.number()),
});

export type WebSearchResult = v.InferOutput<typeof webSearchResultSchema>;

export const webSearchOutputSchema = v.strictObject({
  query: v.string(),
  jurisdiction: v.picklist(WEB_SEARCH_JURISDICTIONS),
  results: v.array(webSearchResultSchema),
  provider: v.picklist(WEB_SEARCH_PROVIDER_NAMES),
  answer: v.optional(v.string()),
});

export type WebSearchOutput = v.InferOutput<typeof webSearchOutputSchema>;

export const fetchUrlOutputSchema = v.strictObject({
  url: v.string(),
  title: v.optional(v.string()),
  publishedAt: v.optional(v.string()),
  content: v.string(),
  truncated: v.boolean(),
  provider: v.picklist(URL_FETCHER_NAMES),
});

export type FetchUrlOutput = v.InferOutput<typeof fetchUrlOutputSchema>;

export type WebSearchProviderArgs = {
  query: string;
  jurisdiction: WebSearchJurisdiction;
  freshness: WebSearchFreshness;
  maxResults: number;
  signal: AbortSignal;
};

export type WebSearchProviderResponse = {
  results: WebSearchResult[];
  answer?: string;
};

export type WebSearchProvider = {
  readonly name: WebSearchProviderName;
  search(args: WebSearchProviderArgs): Promise<WebSearchProviderResponse>;
};

export type UrlFetcherArgs = {
  url: string;
  maxChars: number;
  signal: AbortSignal;
};

export type UrlFetcher = {
  readonly name: UrlFetcherName;
  fetch(args: UrlFetcherArgs): Promise<FetchUrlOutput>;
};

export class WebSearchProviderError extends TaggedError(
  "WebSearchProviderError",
)<{
  message: string;
  provider: WebSearchProviderName | UrlFetcherName;
  status: number;
}>() {}
