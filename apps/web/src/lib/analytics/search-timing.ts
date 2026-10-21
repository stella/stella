import { useExternalSyncEffect } from "@/hooks/use-effect";
import { startKeyActionTimer } from "@/lib/analytics/key-action-timing";
import type { KeyActionTimer } from "@/lib/analytics/key-action-timing";
import { getAnalytics } from "@/lib/analytics/provider";
import type { Analytics, SearchTimingSurface } from "@/lib/analytics/types";

// A search whose results never arrive (an error, a page left) leaves its
// start behind; a later result set for the same text is another search.
const SEARCH_RESULTS_ABANDON_AFTER_MS = 60_000;

type PendingSearch = { query: string; timer: KeyActionTimer };

/**
 * Pairs a submitted query with its first result page on screen. The query
 * is written to the URL by the search field and read back by whichever
 * results view the query selects, so the two ends meet on the query text;
 * the text stays in memory and never reaches the event.
 */
export const createSearchTiming = (
  analytics: () => Pick<Analytics, "captureKeyActionTiming">,
  now?: () => number,
) => {
  const pending = new Map<SearchTimingSurface, PendingSearch>();
  return {
    requested: (surface: SearchTimingSurface, rawQuery: string) => {
      pending.get(surface)?.timer.cancel();
      pending.delete(surface);
      const query = rawQuery.trim();
      if (query.length === 0) {
        return;
      }
      pending.set(surface, {
        query,
        timer: startKeyActionTimer(
          analytics(),
          { action: "search-results", surface },
          { abandonAfterMs: SEARCH_RESULTS_ABANDON_AFTER_MS, now },
        ),
      });
    },
    resultsShown: (surface: SearchTimingSurface, rawQuery: string) => {
      const search = pending.get(surface);
      if (search?.query !== rawQuery.trim()) {
        return;
      }
      pending.delete(surface);
      search.timer.finish();
    },
  };
};

export const searchTiming = createSearchTiming(getAnalytics);

/** Ends the pending search for `query` once its results are committed:
 *  `shown` is true only for data fetched for this query, never for the
 *  previous result set a placeholder keeps on screen. */
export const useSearchResultsTiming = (
  surface: SearchTimingSurface,
  query: string,
  shown: boolean,
) => {
  useExternalSyncEffect(() => {
    if (shown) {
      searchTiming.resultsShown(surface, query);
    }
  }, [query, shown, surface]);
};
