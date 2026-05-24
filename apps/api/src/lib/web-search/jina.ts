import type {
  FetchUrlOutput,
  UrlFetcher,
  UrlFetcherArgs,
} from "@/api/lib/web-search/types";

const JINA_READER_BASE = "https://r.jina.ai";

type CreateJinaFetcherArgs = {
  apiKey: string | undefined;
};

const parseJinaHeader = (response: Response, name: string): string | null => {
  const value = response.headers.get(name);
  return value && value.length > 0 ? value : null;
};

export const createJinaFetcher = ({
  apiKey,
}: CreateJinaFetcherArgs): UrlFetcher => ({
  name: "jina",
  fetch: async ({
    url,
    maxChars,
    signal,
  }: UrlFetcherArgs): Promise<FetchUrlOutput> => {
    // Jina Reader accepts the raw URL appended to its base; returns
    // clean markdown plus structured metadata in headers. The
    // x-respond-with header switches to JSON when we need structured
    // data, but markdown body + headers is simpler and one fewer
    // parse step. Keyless usage is rate-limited; an API key
    // bumps the budget.
    const readerUrl = `${JINA_READER_BASE}/${url}`;
    const response = await fetch(readerUrl, {
      headers: {
        accept: "text/plain",
        "x-with-generated-alt": "false",
        "x-no-cache": "false",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Jina Reader failed (${response.status}) for ${url.slice(0, 200)}`,
      );
    }
    const body = await response.text();
    const truncated = body.length > maxChars;
    const content = truncated ? body.slice(0, maxChars) : body;
    const title = parseJinaHeader(response, "x-title");
    const publishedAt = parseJinaHeader(response, "x-published-time");
    const canonicalUrl = parseJinaHeader(response, "x-url") ?? url;
    return {
      url: canonicalUrl,
      content,
      truncated,
      provider: "jina",
      ...(title ? { title } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    };
  },
});
