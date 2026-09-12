import { Result } from "better-result";
import { expect, test } from "bun:test";

import { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
import {
  createBrowseFacetsCache,
  createTtlResultCache,
} from "@/api/lib/legal-search/browse-facets-cache";
import type {
  LegalBrowseFacets,
  LegalBrowseFacetsQuery,
} from "@/api/lib/legal-search/types";

/**
 * The cache is what keeps the browse page off a multi-million-row aggregation
 * on every request, so what it must not do is serve one jurisdiction's counts
 * for another, pin a failure for the whole window, or let a burst of cold
 * requests each fire their own provider call.
 */

const facets = (country: string): LegalBrowseFacets => ({
  country: [{ value: country, count: 1 }],
  court: [],
  year: [],
});

const cacheOf = (
  load: (
    query: LegalBrowseFacetsQuery,
  ) => Promise<Result<LegalBrowseFacets, LegalBrowseFacetsError>>,
) => createBrowseFacetsCache({ load, ttlMs: 60_000, maxEntries: 3 });

test("serves a repeat request from cache", async () => {
  let calls = 0;
  const browseFacets = cacheOf(async () => {
    calls += 1;
    return Result.ok(facets("CZE"));
  });

  await browseFacets({ excludedSourceIds: [], limit: 20 });
  const second = await browseFacets({ excludedSourceIds: [], limit: 20 });

  expect(calls).toBe(1);
  if (Result.isError(second)) {
    throw second.error;
  }
  expect(second.value.country).toEqual([{ value: "CZE", count: 1 }]);
});

test("keys on every input that changes the answer", async () => {
  const seen: LegalBrowseFacetsQuery[] = [];
  const browseFacets = cacheOf(async (query) => {
    seen.push(query);
    return Result.ok(facets(query.jurisdiction ?? "*"));
  });

  await browseFacets({ excludedSourceIds: [], limit: 20 });
  await browseFacets({ excludedSourceIds: [], jurisdiction: "CZE", limit: 20 });
  const scoped = await browseFacets({
    excludedSourceIds: [],
    jurisdiction: "SVK",
    limit: 20,
  });
  await browseFacets({ excludedSourceIds: [], limit: 10 });

  expect(seen.length).toBe(4);
  if (Result.isError(scoped)) {
    throw scoped.error;
  }
  expect(scoped.value.country).toEqual([{ value: "SVK", count: 1 }]);
});

test("a revoked source invalidates the entry instead of waiting out its window", async () => {
  let calls = 0;
  const browseFacets = cacheOf(async () => {
    calls += 1;
    return Result.ok(facets("CZE"));
  });

  await browseFacets({ excludedSourceIds: [], limit: 20 });
  await browseFacets({ excludedSourceIds: ["src-1"], limit: 20 });

  // Source policy is an input to the answer, so it belongs in the key: a
  // revocation that only changed the loader's behaviour would keep the
  // revoked source's buckets public for the rest of the window.
  expect(calls).toBe(2);
});

test("reads one source policy under either order it arrives in", async () => {
  let calls = 0;
  const browseFacets = cacheOf(async () => {
    calls += 1;
    return Result.ok(facets("CZE"));
  });

  // The ineligible set is a set; the row order it was read in is not part of
  // the policy and must not split it across two entries.
  await browseFacets({ excludedSourceIds: ["src-1", "src-2"], limit: 20 });
  await browseFacets({ excludedSourceIds: ["src-2", "src-1"], limit: 20 });

  expect(calls).toBe(1);
});

test("concurrent misses share one provider call", async () => {
  let calls = 0;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const browseFacets = cacheOf(async () => {
    calls += 1;
    await gate;
    return Result.ok(facets("CZE"));
  });

  const inFlight = [
    browseFacets({ excludedSourceIds: [], limit: 20 }),
    browseFacets({ excludedSourceIds: [], limit: 20 }),
    browseFacets({ excludedSourceIds: [], limit: 20 }),
  ];
  release();
  await Promise.all(inFlight);

  expect(calls).toBe(1);
});

test("a failure is not cached, so the next request retries", async () => {
  let calls = 0;
  const browseFacets = cacheOf(async () => {
    calls += 1;
    return calls === 1
      ? Result.err(new LegalBrowseFacetsError({ message: "engine down" }))
      : Result.ok(facets("CZE"));
  });

  const failed = await browseFacets({ excludedSourceIds: [], limit: 20 });
  const recovered = await browseFacets({ excludedSourceIds: [], limit: 20 });

  expect(Result.isError(failed)).toBe(true);
  expect(calls).toBe(2);
  expect(Result.isError(recovered)).toBe(false);
});

test("bounds the key space a caller can grow", async () => {
  let calls = 0;
  const browseFacets = cacheOf(async () => {
    calls += 1;
    return Result.ok(facets("CZE"));
  });

  // maxEntries is 3, and the entries must be filled in order, so the fourth
  // jurisdiction evicts the first: a caller probing distinct jurisdictions
  // cannot grow the map without bound.
  await browseFacets({ excludedSourceIds: [], jurisdiction: "cze", limit: 20 });
  await browseFacets({ excludedSourceIds: [], jurisdiction: "svk", limit: 20 });
  await browseFacets({ excludedSourceIds: [], jurisdiction: "pol", limit: 20 });
  await browseFacets({ excludedSourceIds: [], jurisdiction: "eu", limit: 20 });
  await browseFacets({ excludedSourceIds: [], jurisdiction: "cze", limit: 20 });

  expect(calls).toBe(5);
});

test("expires an entry once its window closes", async () => {
  let calls = 0;
  const browseFacets = createBrowseFacetsCache({
    load: async () => {
      calls += 1;
      return Result.ok(facets("CZE"));
    },
    ttlMs: 0,
    maxEntries: 3,
  });

  await browseFacets({ excludedSourceIds: [], limit: 20 });
  await browseFacets({ excludedSourceIds: [], limit: 20 });

  expect(calls).toBe(2);
});

/**
 * A load that fails cheaply is better retried at once, which is the default
 * above. A load that fails slowly is not: retrying it per request keeps one
 * call in flight for as long as the dependency stays degraded, so its caller
 * asks for a hold instead.
 */
const failingCacheOf = (failureTtlMs: number) => {
  let calls = 0;
  const read = createTtlResultCache({
    load: async (query: string) => {
      calls += 1;
      return Result.err(
        new LegalBrowseFacetsError({ message: `${query} down` }),
      );
    },
    key: (query: string) => query,
    ttlMs: 60_000,
    failureTtlMs,
    maxEntries: 3,
  });
  return { calls: () => calls, read };
};

test("holds a failure for the window its caller asked for", async () => {
  const { calls, read } = failingCacheOf(60_000);

  await read("engine");
  await read("engine");

  expect(calls()).toBe(1);
});

test("retries once the failure window closes", async () => {
  const { calls, read } = failingCacheOf(0);

  await read("engine");
  await read("engine");

  expect(calls()).toBe(2);
});

test("a slow failure is held from the moment it settles", async () => {
  let calls = 0;
  const read = createTtlResultCache({
    load: async (query: string) => {
      calls += 1;
      // Longer than the hold: a hold counted from the start would have
      // expired before the failure even arrived. Both numbers are far above
      // scheduler jitter, so the second read lands inside the hold on a busy
      // machine rather than intermittently outside it.
      await Bun.sleep(200);
      return Result.err(
        new LegalBrowseFacetsError({ message: `${query} down` }),
      );
    },
    key: (query: string) => query,
    ttlMs: 60_000,
    failureTtlMs: 100,
    maxEntries: 3,
  });

  await read("engine");
  await read("engine");

  expect(calls).toBe(1);
});
