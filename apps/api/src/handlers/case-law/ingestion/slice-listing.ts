/**
 * List one slice with main's persisted reconciliation keys. Court evidence is
 * retained separately before those keys deduplicate the publisher's entries;
 * the census derives its distinct court-qualified observations from it.
 */

import { Result } from "better-result";

import { abortableSleep } from "@/api/handlers/case-law/ingestion/abortable-sleep";
import {
  censusListingEvidenceKey,
  censusListingIdentity,
} from "@/api/lib/case-law/census-listing-identity";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type {
  CensusListingIdentity,
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
  /** Full census evidence before the coarser reconciliation keys deduplicate items. */
  censusIdentities: CensusListingIdentity[];
  /** Items the publisher listed, including repeats and unkeyable ones. */
  listed: number;
  unidentifiable: number;
  duplicate: number;
  /** Absent when the listing exposes only enumeration, rather than a count. */
  publisherCount?: number | undefined;
  /** Page requests the listing made, the first included. */
  pages: number;
};

/**
 * How many passes over a slice each proof makes, for a caller that has to
 * bound a listing's worst case.
 */
export const SLICE_LISTING_PASSES = {
  count: 1,
  identities: 2,
} as const;

/**
 * What a caller needs a listing to prove. `identities` certifies the exact
 * set a slice holds, which is what recording its coverage complete rests on
 * (case-law AGENTS.md rule 19). `count` only sums it: a record replaced
 * between pages leaves the count unchanged, so a second pass would cost the
 * publisher a full listing and change nothing a count can say.
 */
export const SLICE_LISTING_PROOF = {
  COUNT: "count",
  IDENTITIES: "identities",
} as const;

type SliceListingProof =
  (typeof SLICE_LISTING_PROOF)[keyof typeof SLICE_LISTING_PROOF];

type ListReconciliationSliceOptions = {
  adapterKey: string;
  proof: SliceListingProof;
  listSlicePage: SourceReconciliation["listSlicePage"];
  slice: string;
  /** Pause before every page after the first. */
  pageDelayMs: number;
  /** One page request, wire time and any publisher-gate queueing together. */
  pageTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal | undefined;
};

/** One pass over every page of a slice, keyed as the ingest keys it. */
const listSlicePass = async ({
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
    censusIdentities: [],
    listed: 0,
    unidentifiable: 0,
    duplicate: 0,
    pages: 0,
  };
  for (let page = 0; ; page += 1) {
    signal?.throwIfAborted();
    if (page > 0) {
      await abortableSleep(sleep, pageDelayMs, signal);
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
    if (listed.publisherCount !== undefined) {
      if (
        !Number.isSafeInteger(listed.publisherCount) ||
        listed.publisherCount < 0 ||
        (listing.publisherCount !== undefined &&
          listing.publisherCount !== listed.publisherCount)
      ) {
        return Result.err(
          new AdapterFetchError({
            message:
              "Slice listing stated an invalid or changing publisher count",
            adapterKey,
            cursor: slice,
          }),
        );
      }
      listing.publisherCount = listed.publisherCount;
    }
    listing.pages += 1;
    listing.listed += listed.items.length;
    for (const item of listed.items) {
      listing.censusIdentities.push(censusListingIdentity(item));
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

const sameCensusEvidence = (
  first: readonly CensusListingIdentity[],
  second: readonly CensusListingIdentity[],
): boolean => {
  const keys = (entries: readonly CensusListingIdentity[]) =>
    new Set(
      entries.map(censusListingEvidenceKey).filter((key) => key !== null),
    );
  const left = keys(first);
  const right = keys(second);
  return left.size === right.size && [...left].every((key) => right.has(key));
};

const sameIdentities = (first: ListedSlice, second: ListedSlice): boolean =>
  first.publisherCount === second.publisherCount &&
  first.unidentifiable === second.unidentifiable &&
  sameCensusEvidence(first.censusIdentities, second.censusIdentities) &&
  first.keyed.size === second.keyed.size &&
  [...first.keyed.keys()].every((identityKey) => second.keyed.has(identityKey));

/**
 * Every page of one slice, or an error. Never a partial listing: an
 * undercount would be recorded as if it were the whole slice, and an
 * undercounted slice can read as fully collected. A page request that rejects
 * rejects this call with the adapter's own error, so a caller that classifies
 * adapter failures still sees them unchanged.
 *
 * Under the `identities` proof a non-empty slice is listed twice and accepted
 * only when both passes name the same identities (case-law AGENTS.md rule
 * 19). One pass cannot see a record the publisher inserted at an offset it
 * had already read: the reported count and the distinct identities still
 * agree, and the slice would read as fully collected while that record was
 * never listed. A changed slice is refused like any failed listing, so its
 * previous ledger row stands and a later walk lists it again. A slice that
 * answered empty in one request costs that request: there is nothing a second
 * pass could find that the first replaced. One read empty across several
 * requests is verified like any other, since a record can land on a page the
 * walk has already passed.
 */
export const listReconciliationSlice = async (
  options: ListReconciliationSliceOptions,
): Promise<Result<ListedSlice, AdapterFetchError>> => {
  const first = await listSlicePass(options);
  if (
    Result.isError(first) ||
    (first.value.listed === 0 && first.value.pages === 1) ||
    options.proof === SLICE_LISTING_PROOF.COUNT
  ) {
    return first;
  }
  const { adapterKey, pageDelayMs, slice, sleep, signal } = options;
  await abortableSleep(sleep, pageDelayMs, signal);
  const verification = await listSlicePass(options);
  if (Result.isError(verification)) {
    return verification;
  }
  return sameIdentities(first.value, verification.value)
    ? first
    : Result.err(
        new AdapterFetchError({
          message: `Slice ${slice} changed while it was listed: ${String(first.value.keyed.size)} identities, then ${String(verification.value.keyed.size)}`,
          adapterKey,
          cursor: slice,
        }),
      );
};
