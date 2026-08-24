/**
 * The census exists because the ingest path's own signals cannot detect
 * the gap it looks for: a row whose split was lost has an `indexedHash`
 * equal to its content hash, so it is neither missing nor stale and
 * nothing selects it again. What can go wrong here is therefore the
 * census staying quiet — either because ordinary churn is mistaken for
 * drift and the warning is tuned out, or because an unreachable index
 * reads as an empty one and the drift is reported against an index that
 * is fine — and, since generation 3 shares one index between several
 * countries, the sweep counting the same index once per country.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CENSUS_CYCLE_INTERVAL,
  CENSUS_DISPOSITION,
  CENSUS_TOLERANCE,
  DELETE_SETTLEMENT_STALE_MS,
  CaseLawCorpusIndexCountNotReadyError,
  censusIndex,
  createCaseLawCensus,
  createCaseLawCorpusIndexCountSeed,
  reportIndexCensus,
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

/** Index ids the engine was asked to count, in request order. */
let countedIndexIds: string[];
let countedMaxHits: unknown[];

const indexIdOfCountRequest = (url: string): string | undefined =>
  /\/api\/v1\/(?<indexId>[^/]+)\/search/u.exec(url)?.groups?.["indexId"];

/** Serves the engine's document count, and nothing else. */
const engineHolding = (
  numHits: number,
  ok = true,
  splitOpstamps: readonly number[] = [],
  splitOk = true,
): void => {
  const resolveUrl = (input: Parameters<typeof fetch>[0]): string => {
    if (typeof input === "string") {
      return input;
    }
    return input instanceof URL ? input.href : input.url;
  };
  const stub = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = resolveUrl(input);
    if (!ok) {
      return new Response("index not found", { status: 404 });
    }
    if (url.includes("/search")) {
      const indexId = indexIdOfCountRequest(url);
      if (indexId !== undefined) {
        countedIndexIds.push(indexId);
      }
      const body: Record<string, unknown> = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      );
      countedMaxHits.push(body["max_hits"]);
      return new Response(
        JSON.stringify({
          num_hits: numHits,
          hits: [{ document_id: "count-hit" }],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/splits")) {
      if (!splitOk) {
        return new Response("split list unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          offset: 0,
          size: splitOpstamps.length,
          splits: splitOpstamps.map((opstamp) => ({
            split_state: "Published",
            delete_opstamp: opstamp,
          })),
        }),
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
 * A database whose only answer is the maintained count the census asks for.
 * The lookup returns one row; the engine supplies the other side.
 */
const databaseHolding = (
  marked: number,
  jurisdictions?: string[],
  countStatus = "complete",
  deleteOpstamp?: number,
  pendingDelete: { count: number; oldest: Date | null } = {
    count: 0,
    oldest: null,
  },
): ScopedDb => {
  const handle = async (callback: (tx: Transaction) => Promise<unknown>) => {
    let rows: Record<string, unknown>[] = [];
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      limit: () => rows,
      orderBy: () => chain,
      where: () => rows,
    };
    const tx = {
      delete: () => chain,
      select: (selection: Record<string, unknown>) => {
        rows =
          "status" in selection
            ? [{ marked, status: countStatus }]
            : "pendingDocuments" in selection
              ? [
                  {
                    oldestPendingAt: pendingDelete.oldest,
                    pendingDocuments: pendingDelete.count,
                  },
                ]
              : "opstamp" in selection && deleteOpstamp !== undefined
                ? [{ opstamp: deleteOpstamp }]
                : [];
        return chain;
      },
      selectDistinct: () => {
        rows = (jurisdictions ?? []).map((country) => ({ country }));
        return chain;
      },
    };
    // SAFETY: the census only builds the two inert query chains above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- inert query-builder double
    return await callback(tx as unknown as Transaction);
  };
  // SAFETY: brand-only wrapper; the census never inspects the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  return handle as unknown as ScopedDb;
};

beforeEach(() => {
  countedIndexIds = [];
  countedMaxHits = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("count seed driver", () => {
  let seedWarn: ReturnType<typeof spyOn<typeof logger, "warn">>;

  beforeEach(() => {
    seedWarn = spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    seedWarn.mockRestore();
  });

  test("advances once per cycle and stops permanently at completion", async () => {
    const statuses = ["running", "complete"] as const;
    let calls = 0;
    const seed = createCaseLawCorpusIndexCountSeed({
      generation: GENERATION,
      scopedDb: databaseHolding(0),
      advance: async (_scopedDb, generation) => ({
        generation,
        processed: 1,
        status: statuses.at(calls++) ?? "complete",
      }),
    });

    await seed.step();
    await seed.step();
    await seed.step();

    expect(calls).toBe(2);
  });

  test("contains a failed page and retries it on the next cycle", async () => {
    let calls = 0;
    const seed = createCaseLawCorpusIndexCountSeed({
      generation: GENERATION,
      scopedDb: databaseHolding(0),
      advance: async (_scopedDb, generation) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("pool exhausted");
        }
        return { generation, processed: 0, status: "complete" };
      },
    });

    await seed.step();
    await seed.step();
    await seed.step();

    expect(calls).toBe(2);
    expect(seedWarn.mock.calls.at(0)?.at(0)).toBe(
      "case_law.corpus_index.count_seed_failed",
    );
  });
});

describe("index census", () => {
  test("noise inside the tolerance is not a shortfall", async () => {
    engineHolding(10_000 - CENSUS_TOLERANCE);

    const census = await censusIndex({
      scopedDb: databaseHolding(10_000),
      generation: GENERATION,
      indexId: INDEX_ID,
    });

    expect(census.isOk()).toBe(true);
    expect(census.isOk() && census.value.disposition).toBe(
      CENSUS_DISPOSITION.aligned,
    );
  });

  test("one lost ingest batch is visible on a large index", async () => {
    // The whole failure this detects is a fixed-size batch going
    // missing, so the tolerance must stay below one — and must not grow
    // with the corpus, or a large index hides more the larger it gets.
    // `corpusIndexBatchSize` is the size of the smallest real loss.
    const marked = 5_000_000;
    engineHolding(marked - LIMITS.corpusIndexBatchSize);

    const census = await censusIndex({
      scopedDb: databaseHolding(marked),
      generation: GENERATION,
      indexId: INDEX_ID,
    });

    expect(census.isOk() && census.value.disposition).toBe(
      CENSUS_DISPOSITION.short,
    );
    expect(census.isOk() && census.value.indexId).toBe(INDEX_ID);
    expect(countedIndexIds).toEqual([INDEX_ID]);
    expect(countedMaxHits).toEqual([1]);
  });

  test("an engine holding more than Postgres claims is a surplus, not silence", async () => {
    // Entries no row points at are a defect of their own, and — the
    // reason this direction cannot simply be ignored — each one cancels
    // a genuinely missing document in the same subtraction. Reporting
    // the surplus is what stops the pair going quiet together.
    engineHolding(50_000);

    const census = await censusIndex({
      scopedDb: databaseHolding(10_000),
      generation: GENERATION,
      indexId: INDEX_ID,
    });

    expect(census.isOk() && census.value.shortfall).toBeLessThan(0);
    expect(census.isOk() && census.value.disposition).toBe(
      CENSUS_DISPOSITION.surplus,
    );
  });

  test("a retained delete task explains surplus until every split applies it", async () => {
    engineHolding(50_000, true, [42, 41, 45]);

    const census = await censusIndex({
      scopedDb: databaseHolding(10_000, undefined, "complete", 42, {
        count: 40_000,
        oldest: new Date(),
      }),
      generation: GENERATION,
      indexId: INDEX_ID,
    });

    expect(census.isOk() && census.value.disposition).toBe(
      CENSUS_DISPOSITION.pendingDelete,
    );
    expect(census.isOk() && census.value.deleteSettlement).toEqual({
      requiredOpstamp: 42,
      publishedSplits: 3,
      laggingSplits: 1,
      minAppliedOpstamp: 41,
      pendingDocuments: 40_000,
      oldestPendingAt: expect.any(Date),
      stale: false,
      settled: false,
    });
  });

  test("a pending delete explains no more surplus than its document set", async () => {
    engineHolding(50_000, true, [41]);

    const census = await censusIndex({
      scopedDb: databaseHolding(10_000, undefined, "complete", 42, {
        count: 10,
        oldest: new Date(),
      }),
      generation: GENERATION,
      indexId: INDEX_ID,
    });

    expect(census.isOk() && census.value.disposition).toBe(
      CENSUS_DISPOSITION.surplus,
    );
  });

  test("a split settlement failure stays in the census Result", async () => {
    engineHolding(50_000, true, [41], false);

    const census = await censusIndex({
      scopedDb: databaseHolding(10_000, undefined, "complete", 42),
      generation: GENERATION,
      indexId: INDEX_ID,
    });

    expect(census.isErr()).toBe(true);
  });

  test("an unreachable index is a failure, not an empty index", async () => {
    // Counting it as empty would report the whole index as drifted and
    // point the repair at rows that are perfectly indexed.
    engineHolding(0, false);

    const census = await censusIndex({
      scopedDb: databaseHolding(10_000),
      generation: GENERATION,
      indexId: INDEX_ID,
    });

    expect(census.isErr()).toBe(true);
  });

  test("a partially seeded exact count is unavailable, never zero", async () => {
    engineHolding(0);

    const rejection: unknown = await censusIndex({
      scopedDb: databaseHolding(10_000, undefined, "running"),
      generation: GENERATION,
      indexId: INDEX_ID,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(CaseLawCorpusIndexCountNotReadyError);
    expect(countedIndexIds).toEqual([]);
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
    reportIndexCensus({
      generation: GENERATION,
      previous: CENSUS_DISPOSITION.short,
      census: {
        indexId: INDEX_ID,
        engineDocuments: 900,
        markedIndexed: 10_000,
        shortfall: 9100,
        disposition: CENSUS_DISPOSITION.short,
        deleteSettlement: null,
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
    reportIndexCensus({
      generation: GENERATION,
      previous: CENSUS_DISPOSITION.aligned,
      census: {
        indexId: INDEX_ID,
        engineDocuments: 10_000,
        markedIndexed: 10_000,
        shortfall: 0,
        disposition: CENSUS_DISPOSITION.aligned,
        deleteSettlement: null,
      },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  test("a first short observation waits for confirmation", () => {
    // A bulk page marks its rows before the engine publishes their
    // split, so one short reading may be work in flight. Warning on it
    // would make every rebuild noisy, and a noisy warning is not read.
    reportIndexCensus({
      generation: GENERATION,
      previous: undefined,
      census: {
        indexId: INDEX_ID,
        engineDocuments: 900,
        markedIndexed: 10_000,
        shortfall: 9100,
        disposition: CENSUS_DISPOSITION.short,
        deleteSettlement: null,
      },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  test("a surplus is reported rather than read as agreement", () => {
    reportIndexCensus({
      generation: GENERATION,
      previous: CENSUS_DISPOSITION.surplus,
      census: {
        indexId: INDEX_ID,
        engineDocuments: 12_000,
        markedIndexed: 10_000,
        shortfall: -2000,
        disposition: CENSUS_DISPOSITION.surplus,
        deleteSettlement: null,
      },
    });

    expect(warn.mock.calls.at(0)?.at(1)).toMatchObject({
      disposition: CENSUS_DISPOSITION.surplus,
    });
  });

  test("a surplus with an unapplied retained delete is not reported as drift", () => {
    reportIndexCensus({
      generation: GENERATION,
      previous: CENSUS_DISPOSITION.pendingDelete,
      census: {
        indexId: INDEX_ID,
        engineDocuments: 12_000,
        markedIndexed: 10_000,
        shortfall: -2000,
        disposition: CENSUS_DISPOSITION.pendingDelete,
        deleteSettlement: {
          requiredOpstamp: 42,
          publishedSplits: 3,
          laggingSplits: 1,
          minAppliedOpstamp: 41,
          pendingDocuments: 2000,
          oldestPendingAt: new Date(),
          stale: false,
          settled: false,
        },
      },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  test("an old pending delete is reported as stalled settlement", () => {
    reportIndexCensus({
      generation: GENERATION,
      previous: CENSUS_DISPOSITION.pendingDelete,
      census: {
        indexId: INDEX_ID,
        engineDocuments: 12_000,
        markedIndexed: 10_000,
        shortfall: -2000,
        disposition: CENSUS_DISPOSITION.pendingDelete,
        deleteSettlement: {
          requiredOpstamp: 42,
          publishedSplits: 3,
          laggingSplits: 1,
          minAppliedOpstamp: 41,
          pendingDocuments: 2000,
          oldestPendingAt: new Date(
            Date.now() - DELETE_SETTLEMENT_STALE_MS - 1,
          ),
          stale: true,
          settled: false,
        },
      },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.at(0)?.at(0)).toBe(
      "case_law.corpus_index.delete_settlement_stalled",
    );
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
    expect(warn.mock.calls.at(0)?.at(1)).toMatchObject({ indexId: INDEX_ID });
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

    // The engine aggregate is real query budget; paying it on every backfill
    // batch would answer the same slow-moving question over and over.
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

describe("census sweep unit", () => {
  /** Runs the sweep long enough to census `count` indexes. */
  const sweep = async (
    generation: string,
    jurisdictions: string[],
    count: number,
  ): Promise<string[]> => {
    engineHolding(10_000);
    const census = createCaseLawCensus({
      generation,
      scopedDb: databaseHolding(10_000, jurisdictions),
      startAt: 0,
    });
    for (let cycle = 0; cycle < CENSUS_CYCLE_INTERVAL * count; cycle += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the cycles are the subject of the test
      await census.step();
    }
    return countedIndexIds;
  };

  test("countries sharing an index are one observation from generation 3", async () => {
    // Two countries, one physical index: censusing it once per country
    // would count the same engine index twice and compare it against half
    // its rows each time. Three censuses' worth of cycles must visit the
    // shared index, then the other index, then wrap round to the shared
    // one; a per-country sweep would visit the shared index twice before
    // reaching the other.
    const counted = await sweep("case_law_v3", ["CZE", "SVK", "POL"], 3);
    expect(counted).toEqual([
      "case_law_v3_cs_sk",
      "case_law_v3_pol",
      "case_law_v3_cs_sk",
    ]);
  });

  test("countries keep their own observation before generation 3", async () => {
    const counted = await sweep("case_law_v2", ["CZE", "SVK", "POL"], 3);
    expect(counted).toEqual([
      "case_law_v2_cze",
      "case_law_v2_svk",
      "case_law_v2_pol",
    ]);
  });
});
