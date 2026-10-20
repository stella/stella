/**
 * Listing one reconciliation slice end to end, keyed the way the ingest keys
 * it. Shared by the reconciliation walk, which compares the listing against
 * what is held, and the listing census, which sums it; both must count the
 * same identities, or a census total and the ledger's `reported` would
 * disagree about the same slice.
 */

import { Result } from "better-result";

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

const sleepUntilDelayOrAbort = async (
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  await Promise.race([
    sleep(ms),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Reconciliation sleep aborted")),
        { once: true },
      );
    }),
  ]);
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
  signal?: AbortSignal | undefined;
};

/**
 * Every page of one slice, or an error. Never a partial listing: an
 * undercount would be recorded as if it were the whole slice, and an
 * undercounted slice can read as fully collected. A page request that rejects
 * rejects this call with the adapter's own error, so a caller that classifies
 * adapter failures still sees them unchanged.
 */
export const listReconciliationSlice = async ({
  adapterKey,
  listSlicePage,
  pageDelayMs,
  pageTimeoutMs,
  slice,
  sleep,
  signal,
}: ListReconciliationSliceOptions): Promise<
  Result<ListedSlice, AdapterFetchError>
> => {
  const listing: ListedSlice = {
    keyed: new Map(),
    listed: 0,
    unidentifiable: 0,
    duplicate: 0,
  };
  for (let page = 0; ; page += 1) {
    signal?.throwIfAborted();
    if (page > 0) {
      await sleepUntilDelayOrAbort(sleep, pageDelayMs, signal);
      signal?.throwIfAborted();
    }
    const timeoutSignal = AbortSignal.timeout(pageTimeoutMs);
    const listed = await listSlicePage({
      slice,
      page,
      signal:
        signal === undefined
          ? timeoutSignal
          : AbortSignal.any([signal, timeoutSignal]),
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
      return Result.ok(listing);
    }
    if (page + 1 >= MAX_SLICE_PAGES) {
      return Result.err(
        new AdapterFetchError({
          message: `Slice listing exceeded ${MAX_SLICE_PAGES} pages`,
          adapterKey,
          cursor: slice,
        }),
      );
    }
    // No clock here on purpose: a listing has nowhere to resume from, so
    // cutting one off on time would make a slowly-listing slice unlistable
    // rather than merely slow.
  }
};
