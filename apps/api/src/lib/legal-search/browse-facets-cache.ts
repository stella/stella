import { Result } from "better-result";

import type { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
import type {
  LegalBrowseFacets,
  LegalBrowseFacetsQuery,
} from "@/api/lib/legal-search/types";

/**
 * In-process TTL cache for browse facets. Facet counts describe the whole
 * corpus and move only as it is ingested, so a window of minutes is
 * indistinguishable from live to a reader, and it is what keeps the browse
 * page off the provider on all but the first request of each window.
 *
 * No new infrastructure on purpose: per-process is enough because every
 * process converges on the same counts, and a cold process pays one call.
 */

type BrowseFacetsResult = Result<LegalBrowseFacets, LegalBrowseFacetsError>;

type BrowseFacetsCacheOptions = {
  load: (query: LegalBrowseFacetsQuery) => Promise<BrowseFacetsResult>;
  ttlMs: number;
  /**
   * The jurisdiction is caller-influenced (validated against a pattern, not a
   * closed list), so the key space is bounded here rather than left to grow.
   * The corpus has a handful of jurisdictions, so eviction only ever touches
   * probing traffic.
   */
  maxEntries: number;
};

type CacheEntry = {
  expiresAt: number;
  /**
   * The in-flight call, not its value: concurrent misses share one provider
   * round-trip instead of stampeding it.
   */
  pending: Promise<BrowseFacetsResult>;
};

/**
 * Every input that changes the answer, in a fixed order — never a serialized
 * object, whose key order would follow construction rather than the contract.
 */
const cacheKey = ({
  documentFamily,
  jurisdiction,
  limit,
}: LegalBrowseFacetsQuery): string =>
  `${documentFamily ?? ""}:${jurisdiction ?? ""}:${limit}`;

export const createBrowseFacetsCache = ({
  load,
  ttlMs,
  maxEntries,
}: BrowseFacetsCacheOptions) => {
  const entries = new Map<string, CacheEntry>();

  return async (query: LegalBrowseFacetsQuery): Promise<BrowseFacetsResult> => {
    const key = cacheKey(query);
    const now = Date.now();

    const cached = entries.get(key);
    if (cached && cached.expiresAt > now) {
      return await cached.pending;
    }

    const entry: CacheEntry = { expiresAt: now + ttlMs, pending: load(query) };
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
    // A failure must not pin an empty facet set for the whole window. Drop it
    // only while this call still owns the entry, so a newer one survives.
    if (Result.isError(result) && entries.get(key) === entry) {
      entries.delete(key);
    }
    return result;
  };
};
