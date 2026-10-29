/**
 * Listing one reconciliation slice end to end, keyed the way the ingest keys
 * it. Shared by the reconciliation walk, which compares the listing against
 * what is held, and the listing census, which sums it; both must count the
 * same identities, or a census total and the ledger's `reported` would
 * disagree about the same slice.
 */

import { Result } from "better-result";

import { abortableSleep } from "@/api/handlers/case-law/ingestion/abortable-sleep";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type {
  ListingObservation,
  ReconciliationListingItem,
  SourceReconciliation,
} from "@/api/lib/legal-search/ingestion-types";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";
import {
  countQuarantineCollisions,
  isQuarantineListingIdentity,
  quarantinePeerCollisions,
} from "@/api/lib/legal-search/quarantine-identity";
import { fingerprintReconciliationPayload } from "@/api/lib/legal-search/reconciliation-payload";
import { logger } from "@/api/lib/observability/logger";

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
  /** Durable source evidence kept outside canonical identity matching. */
  observations: Map<string, ListingObservation>;
  /** Distinct keyable identities, first listing of each. */
  keyed: Map<string, ReconciliationListingItem>;
  /** Items the publisher listed, including repeats. */
  listed: number;
  /** Repeats of an identity with the same revision: one record listed twice. */
  duplicate: number;
  /** Page requests the listing made, the first included. */
  pages: number;
  /**
   * Per quarantine identity, the records beyond the first that it was listed
   * for: repeats whose payload revision differs from every earlier one. A
   * publisher id names one document however often it is listed, but a
   * content-addressed id is only as distinct as the fields it hashes, so two
   * records whose stable fields agree share it and only one row can be
   * stored (case-law AGENTS.md rule 17's failure mode). Counted, never
   * folded into `duplicate`.
   */
  quarantineCollisions: Map<string, number>;
  /**
   * Quarantine ids listed both for a quarantined record and as the peer of a
   * keyed one (`ReconciliationListingItem.quarantinePeers`): two records the
   * fingerprint cannot tell apart, which a repair alias would merge.
   */
  quarantinePeerCollisions: string[];
  /**
   * Records the publisher listed that state no stable field to key on, so
   * nothing can be stored for them (`ReconciliationSlicePage.withoutStableFields`).
   */
  withoutStableFields: number;
};

const unstoredCollisionCount = ({
  quarantineCollisions,
}: ListedSlice): number =>
  [...quarantineCollisions.values()].reduce((sum, extra) => sum + extra, 0);

/** Records a slice lists that cannot each have a row of their own. */
export const unstoredRecordCount = (listing: ListedSlice): number =>
  listing.withoutStableFields + unstoredCollisionCount(listing);

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
  revisionOf: SourceReconciliation["revisionOf"];
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
  revisionOf,
  slice,
  sleep,
  signal,
}: ListReconciliationSliceOptions): Promise<
  Result<ListedSlice, AdapterFetchError>
> => {
  const listing: ListedSlice = {
    keyed: new Map(),
    observations: new Map(),
    listed: 0,
    duplicate: 0,
    pages: 0,
    quarantineCollisions: new Map(),
    quarantinePeerCollisions: [],
    withoutStableFields: 0,
  };
  // Only quarantine items are fingerprinted: a publisher id is one record
  // however often it is listed, and hashing every payload would cost every
  // walk for nothing.
  const quarantineObservations: {
    sourceDocumentId: string;
    revision: string;
  }[] = [];
  let repeats = 0;
  const finish = (): ListedSlice => {
    listing.quarantineCollisions = countQuarantineCollisions(
      quarantineObservations,
    );
    listing.duplicate = repeats - unstoredCollisionCount(listing);
    listing.quarantinePeerCollisions = quarantinePeerCollisions(
      [...listing.keyed.values()].map(({ identity, quarantinePeers }) => ({
        sourceDocumentId:
          identity.type === "document" ? identity.sourceDocumentId : "",
        quarantinePeers,
      })),
    );
    return listing;
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
    listing.pages += 1;
    listing.listed +=
      listed.items.length +
      (listed.observations?.length ?? 0) +
      (listed.withoutStableFields ?? 0);
    if (listed.observations !== undefined) {
      for (const observation of listed.observations) {
        const key = observation.identity.fingerprint;
        if (listing.observations.has(key)) {
          repeats += 1;
        } else {
          listing.observations.set(key, observation);
        }
      }
    }
    listing.withoutStableFields += listed.withoutStableFields ?? 0;
    for (const item of listed.items) {
      const identityKey = listingIdentityKey(item.identity);
      if (
        item.identity.type === "document" &&
        isQuarantineListingIdentity(item.identity)
      ) {
        quarantineObservations.push({
          sourceDocumentId: item.identity.sourceDocumentId,
          revision: fingerprintReconciliationPayload(revisionOf(item.payload)),
        });
      }
      if (listing.keyed.has(identityKey)) {
        // A publisher lists a document once per docket it settles; the same
        // publisher identity twice is one document. A quarantine identity
        // repeated with another revision is not, and `finish` separates it.
        repeats += 1;
        continue;
      }
      listing.keyed.set(identityKey, item);
    }
    if (page + 1 >= listed.totalPages) {
      return Result.ok(finish());
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

/**
 * One record per listed record the slice cannot store, from the first pass
 * only, so a verified slice reports each once. Every caller of the walker
 * gets it, so no adapter has to remember to.
 */
const reportUnstoredRecords = (
  { adapterKey, slice }: ListReconciliationSliceOptions,
  listing: ListedSlice,
): void => {
  for (const [sourceDocumentId, extra] of listing.quarantineCollisions) {
    logger.warn("case_law.reconciliation.quarantine_collision", {
      adapterKey,
      slice,
      sourceDocumentId,
      collidingRecords: extra,
    });
  }
  for (const sourceDocumentId of listing.quarantinePeerCollisions) {
    logger.warn("case_law.reconciliation.quarantine_peer_collision", {
      adapterKey,
      slice,
      sourceDocumentId,
    });
  }
  if (listing.withoutStableFields > 0) {
    logger.warn("case_law.reconciliation.records_without_stable_fields", {
      adapterKey,
      slice,
      records: listing.withoutStableFields,
    });
  }
};

const sameIdentities = (first: ListedSlice, second: ListedSlice): boolean =>
  first.keyed.size === second.keyed.size &&
  [...first.keyed.keys()].every((identityKey) =>
    second.keyed.has(identityKey),
  ) &&
  first.observations.size === second.observations.size &&
  [...first.observations.keys()].every((key) => second.observations.has(key));

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
  if (Result.isOk(first)) {
    reportUnstoredRecords(options, first.value);
  }
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
