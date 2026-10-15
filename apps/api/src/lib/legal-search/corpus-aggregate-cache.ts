import { Result } from "better-result";

import { compareCodeUnit } from "@stll/collation";

import type {
  CorpusIndexAggregations,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import type { ServingCorpusIndexGeneration } from "@/api/lib/legal-search/corpus-index-generation-store";
import type { CorpusAggregate } from "@/api/lib/legal-search/corpus-index-search-facets";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Process-local cache and single-flight for corpus-index aggregations.
 *
 * One entry per named aggregation, not per engine call: the facet read groups
 * every facet that shares a query into one call, and that grouping moves when
 * a reader toggles a filter. Keyed per aggregation, the facets whose query did
 * not change are answered from the cache and only the rest are sent, still
 * together in one call.
 *
 * An entry's key is the canonical JSON of everything that decides its
 * answer: the serving target, the visibility scope, and the engine request
 * itself with that one aggregation. The request is serialized whole rather
 * than field by field, so a field the request grows enters the key without
 * anyone listing it here.
 *
 * Nothing here is required for correctness: a cold process, an eviction or a
 * failed flight only means the engine is asked again.
 */

/** The index an aggregation reads: the serving generation and its route. */
type CorpusAggregateTarget = ServingCorpusIndexGeneration & {
  indexId: string;
};

/**
 * What the caller may see. Every caller of the public search counts the same
 * public corpus, narrowed by the sources whose redistribution is revoked; the
 * set is read per request, so a revocation changes the key on the next
 * request and no entry counted under the old policy is served again.
 */
type CorpusAggregateScope = {
  type: "public_corpus";
  excludedSourceIds: readonly string[];
};

type CorpusAggregateCacheLimits = {
  maxEntries: number;
  /**
   * Approximate retained bytes: the UTF-16 size of each stored answer's JSON
   * plus its key. The parsed copy a hit hands out is the reader's, not the
   * cache's.
   */
  maxBytes: number;
  ttlMs: number;
};

/** Named aggregations this reader answered, by where the answer came from. */
export type CorpusAggregateCacheOutcome = {
  hits: number;
  misses: number;
  /** Answers taken from another request's call already in flight. */
  sharedFlights: number;
};

type StoredAggregation = {
  /** Serialized, so no reader can mutate what the next one is served. */
  json: string;
  bytes: number;
  expiresAt: number;
};

type AggregationAnswer = Result<unknown, CorpusIndexError>;

/** UTF-16: a JavaScript string holds two bytes per code unit. */
const BYTES_PER_CODE_UNIT = 2;

/**
 * JSON with every object's keys in code-unit order. Not `@stll/stable-stringify`:
 * it reports a repeated reference as `[circular]`, and an aggregation request
 * reuses objects (the per-bucket decision count, the year ranges), so two
 * different requests could serialize alike.
 */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    isRecord(nested)
      ? Object.fromEntries(
          Object.entries(nested).toSorted(([left], [right]) =>
            compareCodeUnit(left, right),
          ),
        )
      : nested,
  );

type AggregationKeyInput = {
  target: CorpusAggregateTarget;
  scope: CorpusAggregateScope;
  request: Omit<Parameters<CorpusAggregate>[0], "aggs">;
  name: string;
  aggregation: unknown;
};

const aggregationKey = ({
  target,
  scope,
  request,
  name,
  aggregation,
}: AggregationKeyInput): string =>
  canonicalJson({
    target,
    // A set: the order it was read in must not split one policy in two.
    scope: {
      ...scope,
      excludedSourceIds: scope.excludedSourceIds.toSorted(compareCodeUnit),
    },
    request: { ...request, aggs: { [name]: aggregation } },
  });

type CreateCorpusAggregateCacheOptions = {
  limits: CorpusAggregateCacheLimits;
  /** Epoch milliseconds; injected so expiry is testable without waiting. */
  now: () => number;
};

type CorpusAggregateReaderOptions = {
  target: CorpusAggregateTarget;
  scope: CorpusAggregateScope;
  /** The engine call a miss makes. It takes no caller signal: see below. */
  load: CorpusAggregate;
};

type CorpusAggregateReader = {
  aggregate: CorpusAggregate;
  outcome: () => CorpusAggregateCacheOutcome;
};

export const createCorpusAggregateCache = ({
  limits,
  now,
}: CreateCorpusAggregateCacheOptions) => {
  // Map order is recency order: a hit re-inserts, eviction takes the first.
  const entries = new Map<string, StoredAggregation>();
  const flights = new Map<string, Promise<AggregationAnswer>>();
  let storedBytes = 0;

  const forget = (key: string): void => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return;
    }
    entries.delete(key);
    storedBytes -= entry.bytes;
  };

  const lookup = (key: string): string | null => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= now()) {
      forget(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.json;
  };

  const store = (key: string, value: unknown): void => {
    // An aggregation the engine did not answer is left for the parse to
    // refuse, and never pinned as an answer.
    if (value === undefined) {
      return;
    }
    const json = JSON.stringify(value);
    const bytes = (key.length + json.length) * BYTES_PER_CODE_UNIT;
    forget(key);
    if (bytes > limits.maxBytes) {
      return;
    }
    entries.set(key, { json, bytes, expiresAt: now() + limits.ttlMs });
    storedBytes += bytes;
    while (entries.size > limits.maxEntries || storedBytes > limits.maxBytes) {
      const oldest = entries.keys().next();
      if (oldest.done) {
        return;
      }
      forget(oldest.value);
    }
  };

  /**
   * A reader for one request. The flight a miss starts belongs to no caller:
   * the engine call carries only its own timeout, so a request that stops
   * waiting cannot cancel what other requests share. A flight that fails is
   * answered to the requests waiting on it and then dropped, never stored, so
   * the next request asks the engine again.
   */
  const reader = ({
    target,
    scope,
    load,
  }: CorpusAggregateReaderOptions): CorpusAggregateReader => {
    const outcome: CorpusAggregateCacheOutcome = {
      hits: 0,
      misses: 0,
      sharedFlights: 0,
    };

    const aggregate: CorpusAggregate = async ({ aggs, ...request }) => {
      const answered: [string, unknown][] = [];
      const waits: [string, Promise<AggregationAnswer>][] = [];
      const missing: { name: string; key: string }[] = [];
      for (const [name, aggregation] of Object.entries(aggs)) {
        const key = aggregationKey({
          target,
          scope,
          request,
          name,
          aggregation,
        });
        const json = lookup(key);
        if (json !== null) {
          outcome.hits += 1;
          const cached: unknown = JSON.parse(json);
          answered.push([name, cached]);
          continue;
        }
        const flight = flights.get(key);
        if (flight !== undefined) {
          outcome.sharedFlights += 1;
          waits.push([name, flight]);
          continue;
        }
        missing.push({ name, key });
      }

      if (missing.length > 0) {
        outcome.misses += missing.length;
        const missingAggs = Object.fromEntries(
          missing.map(({ name }) => [name, aggs[name]]),
        );
        const release = (): void => {
          for (const { key } of missing) {
            flights.delete(key);
          }
        };
        // Settled before any waiter resumes, so a request that follows a
        // failure finds no flight to join and no entry to read.
        const call = load({ ...request, aggs: missingAggs })
          .then((answer) => {
            if (Result.isOk(answer)) {
              for (const { name, key } of missing) {
                store(key, answer.value[name]);
              }
            }
            return answer;
          })
          .finally(release);
        for (const { name, key } of missing) {
          const named = call.then((answer): AggregationAnswer =>
            Result.isOk(answer)
              ? Result.ok(answer.value[name])
              : Result.err(answer.error),
          );
          flights.set(key, named);
          waits.push([name, named]);
        }
      }

      const results = await Promise.all(
        waits.map(async ([name, wait]) => ({ name, answer: await wait })),
      );
      for (const { name, answer } of results) {
        if (Result.isError(answer)) {
          return answer;
        }
        if (answer.value !== undefined) {
          answered.push([name, answer.value]);
        }
      }
      const aggregations: CorpusIndexAggregations =
        Object.fromEntries(answered);
      return Result.ok(aggregations);
    };

    return { aggregate, outcome: () => ({ ...outcome }) };
  };

  return { reader };
};
