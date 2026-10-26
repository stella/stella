import type {
  WebSearchProvider,
  WebSearchProviderArgs,
  WebSearchProviderResponse,
} from "@/api/lib/web-search/types";

const WEB_SEARCH_TIMEOUT_MS = 10_000;

export type WebSearchRequestObserver = () => void;

const composeSignal = (
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!abortSignal) {
    return timeoutSignal;
  }
  return AbortSignal.any([abortSignal, timeoutSignal]);
};

/** One accounted provider request, shared by direct and registry web search. */
export const searchWeb = async ({
  provider,
  observer,
  abortSignal,
  ...args
}: Omit<WebSearchProviderArgs, "signal"> & {
  provider: WebSearchProvider;
  observer: WebSearchRequestObserver;
  abortSignal?: AbortSignal | undefined;
}): Promise<WebSearchProviderResponse> => {
  observer();
  return await provider.search({
    ...args,
    signal: composeSignal(abortSignal, WEB_SEARCH_TIMEOUT_MS),
  });
};
