import * as v from "valibot";

import { JURISDICTION_ALLOWLIST_DOMAINS } from "@/api/lib/web-search/allowlists";
import type {
  WebSearchProvider,
  WebSearchProviderArgs,
  WebSearchResult,
} from "@/api/lib/web-search/types";
import { WebSearchProviderError } from "@/api/lib/web-search/types";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

const tavilyResponseSchema = v.object({
  query: v.optional(v.string()),
  results: v.array(
    v.object({
      url: v.pipe(v.string(), v.url()),
      title: v.string(),
      content: v.string(),
      score: v.optional(v.number()),
      published_date: v.optional(v.nullable(v.string())),
    }),
  ),
});

const TAVILY_TIME_RANGE_BY_FRESHNESS: Record<
  WebSearchProviderArgs["freshness"],
  string | undefined
> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
  any: undefined,
};

const extractHostname = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
};

type CreateTavilyProviderArgs = {
  apiKey: string;
};

export const createTavilyProvider = ({
  apiKey,
}: CreateTavilyProviderArgs): WebSearchProvider => ({
  name: "tavily",
  search: async ({
    query,
    jurisdiction,
    freshness,
    maxResults,
    signal,
  }): Promise<WebSearchResult[]> => {
    const includeDomains = JURISDICTION_ALLOWLIST_DOMAINS[jurisdiction];
    const timeRange = TAVILY_TIME_RANGE_BY_FRESHNESS[freshness];
    const response = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        topic: "general",
        max_results: maxResults,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        ...(includeDomains.length > 0
          ? { include_domains: [...includeDomains] }
          : {}),
        ...(timeRange ? { time_range: timeRange } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new WebSearchProviderError({
        provider: "tavily",
        status: response.status,
        message: `Tavily search failed (${response.status}): ${body.slice(0, 200)}`,
      });
    }
    const json = v.parse(tavilyResponseSchema, await response.json());
    const results: WebSearchResult[] = [];
    for (const [index, result] of json.results.slice(0, maxResults).entries()) {
      const entry: WebSearchResult = {
        id: `tavily-${index}`,
        url: result.url,
        title: result.title,
        snippet: result.content,
        source: extractHostname(result.url),
      };
      if (result.published_date) {
        entry.publishedAt = result.published_date;
      }
      if (typeof result.score === "number") {
        entry.score = result.score;
      }
      results.push(entry);
    }
    return results;
  },
});
