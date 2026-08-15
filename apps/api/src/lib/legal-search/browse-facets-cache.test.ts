import { Result } from "better-result";
import { expect, test } from "bun:test";

import { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
import { createBrowseFacetsCache } from "@/api/lib/legal-search/browse-facets-cache";
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

  await browseFacets({ limit: 20 });
  const second = await browseFacets({ limit: 20 });

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

  await browseFacets({ limit: 20 });
  await browseFacets({ jurisdiction: "CZE", limit: 20 });
  const scoped = await browseFacets({ jurisdiction: "SVK", limit: 20 });
  await browseFacets({ limit: 10 });

  expect(seen.length).toBe(4);
  if (Result.isError(scoped)) {
    throw scoped.error;
  }
  expect(scoped.value.country).toEqual([{ value: "SVK", count: 1 }]);
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
    browseFacets({ limit: 20 }),
    browseFacets({ limit: 20 }),
    browseFacets({ limit: 20 }),
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

  const failed = await browseFacets({ limit: 20 });
  const recovered = await browseFacets({ limit: 20 });

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
  await browseFacets({ jurisdiction: "cze", limit: 20 });
  await browseFacets({ jurisdiction: "svk", limit: 20 });
  await browseFacets({ jurisdiction: "pol", limit: 20 });
  await browseFacets({ jurisdiction: "eu", limit: 20 });
  await browseFacets({ jurisdiction: "cze", limit: 20 });

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

  await browseFacets({ limit: 20 });
  await browseFacets({ limit: 20 });

  expect(calls).toBe(2);
});
