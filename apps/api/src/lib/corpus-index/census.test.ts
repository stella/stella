/**
 * The census exists because the ingest path's own signals cannot detect
 * the gap it looks for: a row whose split was lost has an `indexedHash`
 * equal to its content hash, so it is neither missing nor stale and
 * nothing selects it again. What can go wrong here is therefore the
 * census staying quiet — either because ordinary churn is mistaken for
 * drift and the warning is tuned out, or because an unreachable index
 * reads as an empty one and the drift is reported against a jurisdiction
 * that is fine.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CENSUS_CYCLE_INTERVAL,
  CENSUS_TOLERANCE,
  censusJurisdiction,
  createCaseLawCensus,
  reportJurisdictionCensus,
} from "@/api/lib/corpus-index/census";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

const GENERATION = "case_law_v1";
const JURISDICTION = "SVK";
const INDEX_ID = corpusIndexId(GENERATION, JURISDICTION);

/** Phases the sweep so the first census lands on the last cycle counted. */
const LAST_CYCLE_START = 0.99;

const originalFetch = globalThis.fetch;

/** Serves the engine's document count, and nothing else. */
const engineHolding = (numHits: number, ok = true): void => {
  const resolveUrl = (input: Parameters<typeof fetch>[0]): string => {
    if (typeof input === "string") {
      return input;
    }
    return input instanceof URL ? input.href : input.url;
  };
  const stub = async (input: Parameters<typeof fetch>[0]) => {
    const url = resolveUrl(input);
    if (!ok) {
      return new Response("index not found", { status: 404 });
    }
    if (url.includes("/search")) {
      return new Response(
        JSON.stringify({ num_hits: numHits, hits: [], snippets: [] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
};

/**
 * A database whose only answer is the count the census asks for. Every
 * aggregate the module runs returns the same single row, which is enough
 * because the census takes exactly one count per side.
 */
const databaseHolding = (
  marked: number,
  jurisdictions?: string[],
): ScopedDb => {
  const handle = async (callback: (tx: Transaction) => Promise<unknown>) => {
    const rows =
      jurisdictions === undefined
        ? [{ marked }]
        : jurisdictions.map((country) => ({ country, marked }));
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      limit: () => rows,
      orderBy: () => chain,
      where: () => rows,
    };
    const tx = { select: () => chain, selectDistinct: () => chain };
    // SAFETY: the census only ever builds the two aggregate chains above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- inert query-builder double
    return await callback(tx as unknown as Transaction);
  };
  // SAFETY: brand-only wrapper; the census never inspects the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  return handle as unknown as ScopedDb;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("jurisdiction census", () => {
  test("noise inside the tolerance is not a shortfall", async () => {
    engineHolding(10_000 - CENSUS_TOLERANCE);

    const census = await censusJurisdiction({
      scopedDb: databaseHolding(10_000),
      generation: GENERATION,
      jurisdiction: JURISDICTION,
    });

    expect(census.isOk()).toBe(true);
    expect(census.isOk() && census.value.short).toBe(false);
  });

  test("one lost ingest batch is visible on a large jurisdiction", async () => {
    // The whole failure this detects is a fixed-size batch going
    // missing, so the tolerance must stay below one — and must not grow
    // with the corpus, or a large jurisdiction hides more the larger it
    // gets. `corpusIndexBatchSize` is the size of the smallest real loss.
    const marked = 5_000_000;
    engineHolding(marked - LIMITS.corpusIndexBatchSize);

    const census = await censusJurisdiction({
      scopedDb: databaseHolding(marked),
      generation: GENERATION,
      jurisdiction: JURISDICTION,
    });

    expect(census.isOk() && census.value.short).toBe(true);
    expect(census.isOk() && census.value.indexId).toBe(INDEX_ID);
  });

  test("an engine holding more than Postgres claims is not short", async () => {
    // A superseded document nothing points at is unreachable, not wrong,
    // and a rebuild leaves those behind by design. This is also the
    // direction a batch landing between the two counts pushes, which is
    // why Postgres is counted first.
    engineHolding(50_000);

    const census = await censusJurisdiction({
      scopedDb: databaseHolding(10_000),
      generation: GENERATION,
      jurisdiction: JURISDICTION,
    });

    expect(census.isOk() && census.value.shortfall).toBeLessThan(0);
    expect(census.isOk() && census.value.short).toBe(false);
  });

  test("an unreachable index is a failure, not an empty index", async () => {
    // Counting it as empty would report the whole jurisdiction as
    // drifted and point the repair at rows that are perfectly indexed.
    engineHolding(0, false);

    const census = await censusJurisdiction({
      scopedDb: databaseHolding(10_000),
      generation: GENERATION,
      jurisdiction: JURISDICTION,
    });

    expect(census.isErr()).toBe(true);
  });
});

describe("census reporting", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test("confirmed drift is reported with both counts", () => {
    reportJurisdictionCensus({
      generation: GENERATION,
      confirmed: true,
      census: {
        jurisdiction: JURISDICTION,
        indexId: INDEX_ID,
        engineDocuments: 900,
        markedIndexed: 10_000,
        shortfall: 9100,
        short: true,
      },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.at(0)?.at(0)).toBe(
      "case_law.corpus_index.census_drift",
    );
    // Both counts travel, because the shortfall alone cannot tell an
    // index that lost a split from one that was never built.
    expect(warn.mock.calls.at(0)?.at(1)).toMatchObject({
      engineDocuments: 900,
      indexId: INDEX_ID,
      markedIndexed: 10_000,
      shortfall: 9100,
    });
  });

  test("agreement is silent", () => {
    reportJurisdictionCensus({
      generation: GENERATION,
      confirmed: true,
      census: {
        jurisdiction: JURISDICTION,
        indexId: INDEX_ID,
        engineDocuments: 10_000,
        markedIndexed: 10_000,
        shortfall: 0,
        short: false,
      },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  test("a first short observation waits for confirmation", () => {
    // A bulk page marks its rows before the engine publishes their
    // split, so one short reading may be work in flight. Warning on it
    // would make every rebuild noisy, and a noisy warning is not read.
    reportJurisdictionCensus({
      generation: GENERATION,
      confirmed: false,
      census: {
        jurisdiction: JURISDICTION,
        indexId: INDEX_ID,
        engineDocuments: 900,
        markedIndexed: 10_000,
        shortfall: 9100,
        short: true,
      },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  test("an unreachable index reports separately from drift", async () => {
    engineHolding(0, false);
    const census = createCaseLawCensus({
      generation: GENERATION,
      scopedDb: databaseHolding(10_000, [JURISDICTION]),
      startAt: LAST_CYCLE_START,
    });

    for (let cycle = 0; cycle < CENSUS_CYCLE_INTERVAL; cycle += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the step counts cycles; it only censuses on the last one
      await census.step();
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.at(0)?.at(0)).toBe(
      "case_law.corpus_index.census_unavailable",
    );
  });

  test("the census does not run on every cycle", async () => {
    engineHolding(0, false);
    const census = createCaseLawCensus({
      generation: GENERATION,
      scopedDb: databaseHolding(10_000, [JURISDICTION]),
      startAt: LAST_CYCLE_START,
    });

    for (let cycle = 0; cycle < CENSUS_CYCLE_INTERVAL - 1; cycle += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the cycles are the subject of the test
      await census.step();
    }

    // Two aggregates per census against a corpus this size is real query
    // budget; paying it on every backfill batch would answer the same
    // slow-moving question over and over.
    expect(warn).not.toHaveBeenCalled();
  });

  test("a shortfall is reported once it survives a second census", async () => {
    // The confirmation is what lets the tolerance stay smaller than an
    // ingest batch: a page still publishing clears by the next visit, a
    // lost split never does. Without it the choice would be between
    // warning on every rebuild and never seeing the smallest real loss.
    const marked = 5_000_000;
    engineHolding(marked - LIMITS.corpusIndexBatchSize);
    const census = createCaseLawCensus({
      generation: GENERATION,
      scopedDb: databaseHolding(marked, [JURISDICTION]),
      startAt: LAST_CYCLE_START,
    });

    for (let cycle = 0; cycle < CENSUS_CYCLE_INTERVAL; cycle += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the cycles are the subject of the test
      await census.step();
    }
    expect(warn).not.toHaveBeenCalled();

    for (let cycle = 0; cycle < CENSUS_CYCLE_INTERVAL; cycle += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the cycles are the subject of the test
      await census.step();
    }
    expect(warn.mock.calls.at(0)?.at(0)).toBe(
      "case_law.corpus_index.census_drift",
    );
  });

  test("a census that throws cannot stop the backfill loop", async () => {
    const explode = async () => {
      await Promise.resolve();
      throw new Error("pool exhausted");
    };
    // SAFETY: brand-only wrapper.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    const exploding = explode as unknown as ScopedDb;
    const census = createCaseLawCensus({
      generation: GENERATION,
      scopedDb: exploding,
      startAt: LAST_CYCLE_START,
    });

    for (let cycle = 0; cycle < CENSUS_CYCLE_INTERVAL; cycle += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the cycles are the subject of the test
      await census.step();
    }

    // Trading a silent index gap for a stopped index would be the worse
    // failure, so the diagnostic reports and yields.
    expect(warn.mock.calls.at(0)?.at(0)).toBe(
      "case_law.corpus_index.census_failed",
    );
  });
});
