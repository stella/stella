import { Result } from "better-result";

import type { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
import type {
  LegalBrowseFacets,
  LegalBrowseFacetsQuery,
} from "@/api/lib/legal-search/types";

/**
 * In-process TTL cache for whole-corpus reads (browse facets, the newest
 * decisions per court). Such answers move only as the corpus is ingested, so
 * a window of minutes is indistinguishable from live to a reader, and it is
 * what keeps the browse page off the provider on all but the first request of
 * each window.
 *
 * No new infrastructure on purpose: per-process is enough because every
 * process converges on the same answer, and a cold process pays one call.
 */

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

export const createTtlResultCache = <TQuery, TValue, TError>({
  load,
  key: keyOf,
  ttlMs,
  maxEntries,
}: TtlResultCacheOptions<TQuery, TValue, TError>) => {
  const entries = new Map<string, CacheEntry<TValue, TError>>();

  return async (query: TQuery): Promise<Result<TValue, TError>> => {
    const key = keyOf(query);
    const now = Date.now();

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
    // A failure must not pin an empty answer for the whole window. Drop it
    // only while this call still owns the entry, so a newer one survives.
    if (Result.isError(result) && entries.get(key) === entry) {
      entries.delete(key);
    }
    return result;
  };
};

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
  createTtlResultCache({ ...options, key: browseFacetsCacheKey });
