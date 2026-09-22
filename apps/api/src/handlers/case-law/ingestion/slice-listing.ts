/**
 * Listing one reconciliation slice end to end, keyed the way the ingest keys
 * it. Shared by the reconciliation walk, which compares the listing against
 * what is held, and the listing census, which sums it; both must count the
 * same identities, or a census total and the ledger's `reported` would
 * disagree about the same slice.
 */

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type {
  ReconciliationListingItem,
  SourceReconciliation,
} from "@/api/lib/legal-search/ingestion-types";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";

/**
 * Pages requested for one slice before the listing gives up on it.
 *
 * `totalPages` is the publisher's number and the response validators only
 * require it to be a number at all. Without a ceiling one wrong value turns a
 * single slice into an unbounded request sequence against that publisher.
 * Far above any real slice, so reaching it means the listing is not walkable
 * rather than merely large.
 */
export const MAX_SLICE_PAGES = 200;

export type ListedSlice = {
  /** Distinct keyable identities, first listing of each. */
  keyed: Map<string, ReconciliationListingItem>;
  /** Items the publisher listed, including repeats and unkeyable ones. */
  listed: number;
  unidentifiable: number;
  duplicate: number;
};

type ListReconciliationSliceOptions = {
  adapterKey: string;
  listSlicePage: SourceReconciliation["listSlicePage"];
  slice: string;
  /** Pause before every page after the first. */
  pageDelayMs: number;
  /** One page request, wire time and any publisher-gate queueing together. */
  pageTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * Every page of one slice, or a throw. Never a partial listing: an undercount
 * would be recorded as if it were the whole slice, and an undercounted slice
 * can read as fully collected.
 */
export const listReconciliationSlice = async ({
  adapterKey,
  listSlicePage,
  pageDelayMs,
  pageTimeoutMs,
  slice,
  sleep,
}: ListReconciliationSliceOptions): Promise<ListedSlice> => {
  const listing: ListedSlice = {
    keyed: new Map(),
    listed: 0,
    unidentifiable: 0,
    duplicate: 0,
  };
  for (let page = 0; ; page += 1) {
    if (page > 0) {
      await sleep(pageDelayMs);
    }
    const listed = await listSlicePage({
      slice,
      page,
      signal: AbortSignal.timeout(pageTimeoutMs),
    });
    listing.listed += listed.items.length;
    for (const item of listed.items) {
      const identityKey = listingIdentityKey(item.identity);
      if (identityKey === null) {
        listing.unidentifiable += 1;
        continue;
      }
      if (listing.keyed.has(identityKey)) {
        // A publisher lists a document once per docket it settles; the same
        // identity twice is one document.
        listing.duplicate += 1;
        continue;
      }
      listing.keyed.set(identityKey, item);
    }
    if (page + 1 >= listed.totalPages) {
      return listing;
    }
    if (page + 1 >= MAX_SLICE_PAGES) {
      throw new AdapterFetchError({
        message: `Slice listing exceeded ${MAX_SLICE_PAGES} pages`,
        adapterKey,
        cursor: slice,
      });
    }
    // No clock here on purpose: a listing has nowhere to resume from, so
    // cutting one off on time would make a slowly-listing slice unlistable
    // rather than merely slow.
  }
};
