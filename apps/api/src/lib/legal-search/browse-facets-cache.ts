import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import type { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
import type {
  LegalBrowseFacets,
  LegalBrowseFacetsQuery,
} from "@/api/lib/legal-search/types";

/** Bounded TTL storage for aggregate reads and decision candidates. */

type TtlResultCacheOptions<TQuery, TValue, TError> = {
  load: (query: TQuery) => Promise<Result<TValue, TError>>;
  /**
   * Every input that changes the answer, in a fixed order — never a
   * serialized object, whose key order would follow construction rather than
   * the contract.
   */
  key: (query: TQuery) => string;
  ttlMs: number;
  /**
   * How long a failed load is held before the next request may retry it.
   * Omitted, a failure is evicted at once, which is right for a load that is
   * cheap to repeat; a load that fails slowly needs the hold, or a degraded
   * dependency keeps one call in flight for as long as it stays degraded.
   */
  failureTtlMs?: number;
  /**
   * Caller-influenced inputs (a jurisdiction validated against a pattern, not
   * a closed list) make the key space unbounded, so it is bounded here rather
   * than left to grow. The corpus has a handful of jurisdictions, so eviction
   * only ever touches probing traffic.
   */
  maxEntries: number;
};

type CacheEntry<TValue, TError> = {
  expiresAt: number;
  /**
   * The in-flight call, not its value: concurrent misses share one provider
   * round-trip instead of stampeding it.
   */
  pending: Promise<Result<TValue, TError>>;
};

const createCachedResultReader = <TQuery, TValue, TError>({
  load,
  key: keyOf,
  ttlMs,
  failureTtlMs,
  maxEntries,
}: TtlResultCacheOptions<TQuery, TValue, TError>) => {
  const entries = new Map<string, CacheEntry<TValue, TError>>();

  return async (query: TQuery): Promise<Result<TValue, TError>> => {
    const key = keyOf(query);
    const now = Temporal.Now.instant().epochMilliseconds;

    const cached = entries.get(key);
    if (cached && cached.expiresAt > now) {
      return await cached.pending;
    }

    const entry: CacheEntry<TValue, TError> = {
      expiresAt: now + ttlMs,
      pending: load(query),
    };
    // Re-insert so Map iteration order tracks recency: refreshing a hot key
    // must not leave it first in line for eviction.
    entries.delete(key);
    entries.set(key, entry);

    if (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (!oldest.done) {
        entries.delete(oldest.value);
      }
    }

    const result = await entry.pending;
    // A failure must not pin an empty answer for the whole window: it is
    // dropped, or held for the shorter failure window where the caller asked
    // for one. Either way only while this call still owns the entry, so a
    // newer one survives. The hold starts when the load settles, not when it
    // began: a load that fails slowly would otherwise use up its own hold.
    if (Result.isError(result) && entries.get(key) === entry) {
      if (failureTtlMs === undefined) {
        entries.delete(key);
      } else {
        entry.expiresAt =
          Temporal.Now.instant().epochMilliseconds + failureTtlMs;
      }
    }
    return result;
  };
};

type PublicationPolicy<TQuery, TValue, TError> =
  | {
      kind: "readmit";
      admit: (value: TValue, query: TQuery) => Promise<Result<TValue, TError>>;
    }
  | { kind: "public-static"; reason: string };

type PublishedTtlResultCacheOptions<TQuery, TValue, TError> =
  TtlResultCacheOptions<TQuery, TValue, TError> & {
    publication: PublicationPolicy<TQuery, TValue, TError>;
  };

/** Every cache declares how its responses resolve publication. */
export const createTtlResultCache = <TQuery, TValue, TError>({
  publication,
  ...options
}: PublishedTtlResultCacheOptions<TQuery, TValue, TError>) => {
  const read = createCachedResultReader(options);
  return async (query: TQuery): Promise<Result<TValue, TError>> => {
    const result = await read(query);
    if (Result.isError(result)) {
      return result;
    }
    switch (publication.kind) {
      case "readmit":
        return await publication.admit(result.value, query);
      case "public-static":
        return result;
      default:
        return panic(
          "Unknown cache publication policy",
          publication satisfies never,
        );
    }
  };
};

type AggregateTtlResultCacheOptions<TQuery, TValue, TError> =
  TtlResultCacheOptions<TQuery, TValue, TError> & {
    publication: Extract<
      PublicationPolicy<TQuery, TValue, TError>,
      { kind: "public-static" }
    >;
  };

export const createAggregateTtlResultCache = <TQuery, TValue, TError>(
  options: AggregateTtlResultCacheOptions<TQuery, TValue, TError>,
) => createTtlResultCache(options);

type BrowseFacetsCacheOptions = {
  load: (
    query: LegalBrowseFacetsQuery,
  ) => Promise<Result<LegalBrowseFacets, LegalBrowseFacetsError>>;
  ttlMs: number;
  maxEntries: number;
};

const browseFacetsCacheKey = ({
  documentFamily,
  excludedSourceIds,
  jurisdiction,
  limit,
}: LegalBrowseFacetsQuery): string =>
  // Sorted, because the ineligible set is a set: the order it was read in
  // must not split one source policy across two entries. Source policy is
  // not caller-influenced and changes rarely, so it adds a generation to the
  // key space rather than a dimension.
  `${documentFamily ?? ""}:${jurisdiction ?? ""}:${limit}:${excludedSourceIds.toSorted().join(",")}`;

export const createBrowseFacetsCache = (options: BrowseFacetsCacheOptions) =>
  createAggregateTtlResultCache({
    ...options,
    key: browseFacetsCacheKey,
    publication: {
      kind: "public-static",
      reason: "Browse facets contain aggregate buckets only.",
    },
  });
