import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createCorpusAggregateCache } from "@/api/lib/legal-search/corpus-aggregate-cache";
import {
  CorpusIndexError,
  type CorpusIndexAggregations,
} from "@/api/lib/legal-search/corpus-index-client";
import type { ServingCorpusIndexGeneration } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  type CorpusAggregate,
  type CorpusSearchFacetName,
  readCorpusSearchFacets,
} from "@/api/lib/legal-search/corpus-index-search-facets";

type CacheLimits = Parameters<typeof createCorpusAggregateCache>[0]["limits"];

type CorpusAggregateScope = Parameters<
  ReturnType<typeof createCorpusAggregateCache>["reader"]
>[0]["scope"];

const TTL_MS = 60_000;

const testCache = (limits: Partial<CacheLimits> = {}) => {
  const clock = { now: 0 };
  const cache = createCorpusAggregateCache({
    limits: { maxEntries: 100, maxBytes: 1_000_000, ttlMs: TTL_MS, ...limits },
    now: () => clock.now,
  });
  return { cache, clock };
};

type Target = ServingCorpusIndexGeneration & { indexId: string };

const TARGET: Target = {
  family: "case_law",
  generation: "case_law_v7",
  cluster: "q09",
  indexId: "case_law_v7_cz",
};

const PUBLIC: CorpusAggregateScope = {
  type: "public_corpus",
  excludedSourceIds: [],
};

type EngineCall = { query: string; names: string[] };

/**
 * An engine that answers every aggregation with which call answered it, so a
 * test can tell a cached answer from a fresh one.
 */
const countingEngine = (valueOf?: (name: string) => unknown) => {
  const calls: EngineCall[] = [];
  const load: CorpusAggregate = async ({ query, aggs }) => {
    calls.push({ query, names: Object.keys(aggs).toSorted() });
    const answered: CorpusIndexAggregations = {};
    for (const name of Object.keys(aggs)) {
      answered[name] = valueOf?.(name) ?? { value: calls.length };
    }
    return Result.ok(answered);
  };
  return { calls, load };
};

/** An engine call that answers only when the test says so. */
const deferredEngine = () => {
  const calls: EngineCall[] = [];
  const pending: ((
    answer: Result<CorpusIndexAggregations, CorpusIndexError>,
  ) => void)[] = [];
  const load: CorpusAggregate = async ({ query, aggs }) => {
    calls.push({ query, names: Object.keys(aggs).toSorted() });
    return await new Promise((resolve) => {
      pending.push(resolve);
    });
  };
  const answer = (value: Result<CorpusIndexAggregations, CorpusIndexError>) => {
    for (const resolve of pending.splice(0)) {
      resolve(value);
    }
  };
  return { answer, calls, load };
};

const COUNT_AGGREGATION = { cardinality: { field: "document_id" } };

type ReadOptions = {
  cache: ReturnType<typeof testCache>["cache"];
  load: CorpusAggregate;
  target?: Target;
  scope?: CorpusAggregateScope;
  query?: string;
  aggs?: Record<string, unknown>;
};

const read = async ({
  cache,
  load,
  target = TARGET,
  scope = PUBLIC,
  query = "text:promlčení",
  aggs = { total: COUNT_AGGREGATION },
}: ReadOptions) => {
  const reader = cache.reader({ target, scope, load });
  const answer = await reader.aggregate({ query, aggs });
  return { answer, outcome: reader.outcome() };
};

const valueOf = (
  answer: Result<CorpusIndexAggregations, CorpusIndexError>,
  name = "total",
) => (Result.isOk(answer) ? answer.value[name] : answer.error);

describe("what an aggregation is keyed by", () => {
  const DIMENSIONS = [
    "generation",
    "indexId",
    "query",
    "filter",
    "aggregation",
  ] as const;

  test("corpus aggregate cache key covers the request and target", async () => {
    await assertProperty(
      "corpus aggregate cache key covers the request and target",
      fc.asyncProperty(
        fc.record({
          generation: fc.stringMatching(/^[a-z0-9_]{1,12}$/u),
          indexId: fc.stringMatching(/^[a-z0-9_]{1,16}$/u),
          text: fc.string({ minLength: 1, maxLength: 20 }),
          filters: fc.uniqueArray(
            fc.stringMatching(/^[a-z]{1,8}:[a-z0-9]{1,8}$/u),
            { minLength: 1, maxLength: 5 },
          ),
          field: fc.stringMatching(/^[a-z_]{1,12}$/u),
          dimension: fc.constantFrom(...DIMENSIONS),
          filterIndex: fc.nat(),
        }),
        async ({
          generation,
          indexId,
          text,
          filters,
          field,
          dimension,
          filterIndex,
        }) => {
          const { cache } = testCache();
          const engine = countingEngine();
          const base = {
            target: { ...TARGET, generation, indexId },
            query: [text, ...filters].join(" AND "),
            aggs: { total: { cardinality: { field } } },
          };
          await read({ cache, load: engine.load, ...base });

          // The same request, its target built in another key order.
          const same = await read({
            cache,
            load: engine.load,
            target: {
              indexId,
              cluster: TARGET.cluster,
              generation,
              family: TARGET.family,
            },
            query: base.query,
            aggs: { total: { cardinality: { field } } },
          });
          expect(engine.calls).toHaveLength(1);
          expect(same.outcome).toEqual({
            hits: 1,
            misses: 0,
            sharedFlights: 0,
          });

          const dropped = filterIndex % filters.length;
          const changed = ((): typeof base => {
            switch (dimension) {
              case "generation":
                return {
                  ...base,
                  target: { ...base.target, generation: `${generation}_next` },
                };
              case "indexId":
                return {
                  ...base,
                  target: { ...base.target, indexId: `${indexId}_other` },
                };
              case "query":
                return { ...base, query: `${base.query} AND extra:term` };
              case "filter":
                return {
                  ...base,
                  query: [
                    text,
                    ...filters.filter((_, index) => index !== dropped),
                  ].join(" AND "),
                };
              case "aggregation":
                return {
                  ...base,
                  aggs: { total: { cardinality: { field: `${field}_x` } } },
                };
              default:
                dimension satisfies never;
                throw new Error(`Unhandled dimension: ${String(dimension)}`);
            }
          })();
          const other = await read({ cache, load: engine.load, ...changed });
          expect(engine.calls).toHaveLength(2);
          expect(other.outcome).toEqual({
            hits: 0,
            misses: 1,
            sharedFlights: 0,
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("what an entry is served for", () => {
  test("a new serving generation never reads the previous one's entries", async () => {
    const { cache } = testCache();
    const engine = countingEngine();

    await read({ cache, load: engine.load });
    const next = await read({
      cache,
      load: engine.load,
      target: {
        ...TARGET,
        generation: "case_law_v8",
        indexId: "case_law_v8_cz",
      },
    });

    expect(valueOf(next.answer)).toEqual({ value: 2 });
  });

  test("an entry expires after its window", async () => {
    const { cache, clock } = testCache();
    const engine = countingEngine();

    await read({ cache, load: engine.load });
    clock.now = TTL_MS - 1;
    const warm = await read({ cache, load: engine.load });
    clock.now += TTL_MS;
    const expired = await read({ cache, load: engine.load });

    expect(valueOf(warm.answer)).toEqual({ value: 1 });
    expect(valueOf(expired.answer)).toEqual({ value: 2 });
    expect(engine.calls).toHaveLength(2);
  });
});

describe("single flight", () => {
  const CONCURRENT_REQUESTS = 8;

  test("concurrent identical requests make one engine call", async () => {
    const { cache } = testCache();
    const engine = deferredEngine();

    const reads = Array.from(
      { length: CONCURRENT_REQUESTS },
      async () => await read({ cache, load: engine.load }),
    );
    engine.answer(Result.ok({ total: { value: 42 } }));
    const results = await Promise.all(reads);

    expect(engine.calls).toHaveLength(1);
    for (const { answer } of results) {
      expect(valueOf(answer)).toEqual({ value: 42 });
    }
    const shared = results.reduce(
      (total, { outcome }) => total + outcome.sharedFlights,
      0,
    );
    expect(shared).toBe(CONCURRENT_REQUESTS - 1);
  });

  test("a failed flight reaches its own waiters only and is never cached", async () => {
    const { cache } = testCache();
    const engine = deferredEngine();
    const failure = new CorpusIndexError({ message: "aggregation timed out" });

    const reads = Array.from(
      { length: 3 },
      async () => await read({ cache, load: engine.load }),
    );
    engine.answer(Result.err(failure));
    for (const { answer } of await Promise.all(reads)) {
      expect(valueOf(answer)).toBe(failure);
    }

    const retry = read({ cache, load: engine.load });
    engine.answer(Result.ok({ total: { value: 7 } }));

    expect(valueOf((await retry).answer)).toEqual({ value: 7 });
    expect(engine.calls).toHaveLength(2);
  });

  test("a flight that throws is released for the next request", async () => {
    const { cache } = testCache();
    let calls = 0;
    const load: CorpusAggregate = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("connection reset");
      }
      return Result.ok({ total: { value: 3 } });
    };

    expect(await rejectionOf(read({ cache, load }))).toHaveProperty(
      "message",
      "connection reset",
    );
    const next = await read({ cache, load });

    expect(valueOf(next.answer)).toEqual({ value: 3 });
    expect(calls).toBe(2);
  });

  test("a request that stops waiting does not cancel the flight others share", async () => {
    const { cache } = testCache();
    const engine = deferredEngine();
    const leaving = new AbortController();

    // The request that started the flight gives up on it, as a reader whose
    // connection closed would.
    const abandoned = Promise.race([
      read({ cache, load: engine.load }),
      new Promise<never>((_resolve, reject) => {
        leaving.signal.addEventListener("abort", () => {
          reject(new Error("reader left"));
        });
      }),
    ]);
    const staying = read({ cache, load: engine.load });
    leaving.abort();
    expect(await rejectionOf(abandoned)).toHaveProperty(
      "message",
      "reader left",
    );
    engine.answer(Result.ok({ total: { value: 9 } }));

    expect(valueOf((await staying).answer)).toEqual({ value: 9 });
    // The flight's answer was kept even though its starter left.
    const later = await read({ cache, load: engine.load });
    expect(later.outcome.hits).toBe(1);
    expect(engine.calls).toHaveLength(1);
  });

  test("an aggregation the engine did not answer is not cached", async () => {
    const { cache } = testCache();
    const engine = countingEngine();
    const load: CorpusAggregate = async (input) => {
      await engine.load(input);
      return Result.ok({});
    };

    await read({ cache, load });
    await read({ cache, load });

    expect(engine.calls).toHaveLength(2);
  });
});

describe("bounds", () => {
  const readQuery = async (
    cache: ReturnType<typeof testCache>["cache"],
    load: CorpusAggregate,
    query: string,
  ) => await read({ cache, load, query });

  test("the least recently used entry is evicted past the entry bound", async () => {
    const { cache } = testCache({ maxEntries: 2 });
    const engine = countingEngine();

    await readQuery(cache, engine.load, "a");
    await readQuery(cache, engine.load, "b");
    // Touch `a`, so `b` is now the least recently used.
    await readQuery(cache, engine.load, "a");
    await readQuery(cache, engine.load, "c");
    const a = await readQuery(cache, engine.load, "a");
    const b = await readQuery(cache, engine.load, "b");

    expect(a.outcome.hits).toBe(1);
    expect(b.outcome.misses).toBe(1);
  });

  test("the least recently used entry is evicted past the byte bound", async () => {
    const payload = { buckets: "x".repeat(10_000) };
    // Two bytes per code unit of key and answer. The answer dominates a key of
    // a few hundred code units, so two entries fit and a third does not.
    const answerBytes = JSON.stringify(payload).length * 2;
    const { cache } = testCache({ maxBytes: answerBytes * 2.5 });
    const engine = countingEngine(() => payload);

    await readQuery(cache, engine.load, "a");
    await readQuery(cache, engine.load, "b");
    await readQuery(cache, engine.load, "c");
    const c = await readQuery(cache, engine.load, "c");
    const b = await readQuery(cache, engine.load, "b");
    const a = await readQuery(cache, engine.load, "a");

    expect(c.outcome.hits).toBe(1);
    expect(b.outcome.hits).toBe(1);
    expect(a.outcome.misses).toBe(1);
  });

  test("an answer larger than the whole byte bound is not stored", async () => {
    const { cache } = testCache({ maxBytes: 100 });
    const engine = countingEngine(() => ({ buckets: "x".repeat(100) }));

    await readQuery(cache, engine.load, "a");
    const again = await readQuery(cache, engine.load, "a");

    expect(again.outcome.misses).toBe(1);
  });

  test("a reader cannot change what the next one is served", async () => {
    const { cache } = testCache();
    const engine = countingEngine(() => ({ buckets: [{ key: "court" }] }));

    await read({ cache, load: engine.load });
    const first = await read({ cache, load: engine.load });
    const served = valueOf(first.answer);
    if (typeof served === "object" && served !== null && "buckets" in served) {
      served.buckets = [];
    }
    const second = await read({ cache, load: engine.load });

    expect(valueOf(second.answer)).toEqual({ buckets: [{ key: "court" }] });
  });
});

describe("cross-filter reuse", () => {
  const QUERY = "text:promlčení";
  const COURT_FILTER = "court:nejvyšší";

  /** Every facet and the total answered in the shapes the parse reads. */
  const facetEngine = () =>
    countingEngine((name) =>
      name === "total"
        ? { value: 5 }
        : {
            buckets: [
              {
                key: name === "year" ? "2024" : `${name}-value`,
                doc_count: 9,
                decisions: { value: 2 },
              },
            ],
          },
    );

  const readFacets = async (
    cache: ReturnType<typeof testCache>["cache"],
    load: CorpusAggregate,
    courtFilter: boolean,
  ) => {
    const reader = cache.reader({ target: TARGET, scope: PUBLIC, load });
    const filtered = courtFilter ? `(${QUERY}) AND ${COURT_FILTER}` : QUERY;
    const result = await readCorpusSearchFacets({
      aggregate: reader.aggregate,
      currentYear: 2026,
      decisionCountField: "document_id",
      excludedSourceIds: [],
      // Court is counted without its own filter; every other facet keeps it.
      queryFor: (facet: CorpusSearchFacetName) =>
        facet === "court" ? QUERY : filtered,
      totalQuery: filtered,
    });
    return { result, outcome: reader.outcome() };
  };

  test("toggling one filter re-fetches only the aggregations it changed", async () => {
    const { cache } = testCache();
    const engine = facetEngine();

    const unfiltered = await readFacets(cache, engine.load, false);
    const filtered = await readFacets(cache, engine.load, true);

    expect(Result.isOk(unfiltered.result)).toBe(true);
    expect(Result.isOk(filtered.result)).toBe(true);
    // The unfiltered read is one call; the filtered one sends only the
    // aggregations whose query the filter changed, together, and reads the
    // court facet (counted without its own filter) from the cache.
    expect(engine.calls).toEqual([
      {
        query: QUERY,
        names: [
          "court",
          "courtYear",
          "decisionType",
          "language",
          "source",
          "total",
          "year",
        ],
      },
      {
        query: `(${QUERY}) AND ${COURT_FILTER}`,
        names: [
          "courtYear",
          "decisionType",
          "language",
          "source",
          "total",
          "year",
        ],
      },
    ]);
    expect(filtered.outcome).toEqual({ hits: 1, misses: 6, sharedFlights: 0 });
  });
});
