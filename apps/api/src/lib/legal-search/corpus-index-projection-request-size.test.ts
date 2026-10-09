/**
 * What a request is allowed to carry, driven through the real read pool.
 *
 * The append cycle consumes payloads one at a time and advances the tails per
 * revision, so every flush decision is re-evaluated 512 times a cycle where a
 * read window re-evaluated it 16 times. A cap survives that: it is a property
 * of the tail, so the next one fills from empty either way, and this pins that
 * a full cycle still packs its requests to the ceiling.
 *
 * The other reason a tail flushes, the lease start margin, is a property of
 * the clock rather than the tail, and the cycle stops on it; that behaviour is
 * driven end to end in corpus-index-projection-margin-stop.db.test.ts.
 */

import { describe, expect, test } from "bun:test";

import { streamWithConcurrency } from "@stll/concurrency";

import { CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { advanceCorpusProjectionAppendTails } from "@/api/lib/legal-search/corpus-index-projection-executor";

const REVISIONS = 512;
const READ_CONCURRENCY = 32;
const INDEX_ID = "case_law_v5_cs_sk";
/** ~248 revisions to the 8 MiB cap, the shape the cycle is tuned around. */
const REVISION_BYTES = 33 * 1024;
const CAPFUL = Math.floor(
  CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES / REVISION_BYTES,
);
type Entry = {
  indexId: string;
  ndjson: string;
  ndjsonBytes: number;
  leaseExpiresAtMs: number;
};

type CycleResult = { sizes: number[]; consumed: number };

type Tails = ReturnType<
  typeof advanceCorpusProjectionAppendTails<Entry>
>["tails"];

/**
 * The consumer the executor runs: the real pool, the real tail machinery, one
 * advance per revision, and a request that costs wall-clock time.
 */
const runCycle = async ({
  leaseExpiresAtMs,
  requestMs,
  readMs = 1,
}: {
  leaseExpiresAtMs: number;
  requestMs: number;
  readMs?: number;
}): Promise<CycleResult> => {
  let tails: Tails = new Map();
  const sizes: number[] = [];
  let consumed = 0;
  const payloads = streamWithConcurrency({
    items: Array.from({ length: REVISIONS }, (_unused, index) => index),
    limit: READ_CONCURRENCY,
    lookAhead: READ_CONCURRENCY,
    operation: async (index) => {
      await Bun.sleep(readMs);
      return index;
    },
  });

  for await (const index of payloads) {
    consumed += 1;
    const entry: Entry = {
      indexId: INDEX_ID,
      ndjson: `revision-${index}`,
      ndjsonBytes: REVISION_BYTES,
      leaseExpiresAtMs,
    };
    const advanced = advanceCorpusProjectionAppendTails({
      tails,
      entries: [entry],
      mode: "buffer",
      nowMs: Date.now(),
    });
    tails = advanced.tails;
    if (advanced.flush.length === 0) {
      continue;
    }
    for (const tail of advanced.flush) {
      sizes.push(tail.entries.length);
    }
    await Bun.sleep(requestMs);
    if (advanced.leaseMarginReached) {
      return { sizes, consumed };
    }
  }

  for (const tail of advanceCorpusProjectionAppendTails({
    tails,
    entries: [],
    mode: "flush-all",
    nowMs: Date.now(),
  }).flush) {
    sizes.push(tail.entries.length);
  }
  return { sizes, consumed };
};

describe("append request sizing", () => {
  test("every request but the last fills to the byte cap", async () => {
    const { sizes, consumed } = await runCycle({
      leaseExpiresAtMs: Date.now() + 15 * 60_000,
      requestMs: 5,
    });

    expect(consumed).toBe(REVISIONS);
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(REVISIONS);
    // Two capfuls and the remainder, not a request per revision.
    expect(sizes.slice(0, -1)).toEqual(
      Array.from({ length: sizes.length - 1 }, () => CAPFUL),
    );
    expect(sizes.at(-1)).toBe(REVISIONS - CAPFUL * (sizes.length - 1));
  });
});
