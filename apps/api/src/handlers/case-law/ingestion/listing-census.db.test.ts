import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawSources,
  relations,
  SOURCE_TOTAL_ORIGIN,
} from "@/api/db/schema";
import type { ListingCensusAdapter } from "@/api/handlers/case-law/ingestion/listing-census";
import {
  inspectListingCensus,
  LISTING_CENSUS_CONFIG_KEY,
  LISTING_CENSUS_STATUS,
  MAX_LISTING_CENSUS_SLICES_PER_RUN,
  runListingCensus,
} from "@/api/handlers/case-law/ingestion/listing-census";
import { createSafeId } from "@/api/lib/branded-types";
import { toUtcDateString } from "@/api/lib/dates";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type { ReconciliationListingItem } from "@/api/lib/legal-search/ingestion-types";

// A census is a fold over slices with a durable accumulator. What is asserted
// is the fold's contract rather than one run: however the calls are cut, by
// budget or by a failing listing, the stored result is the one an
// uninterrupted run reaches, a total is written only by the call that counts
// the last slice, and a finished census is never listed or written again.

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

const { createTestPglite } = await import("@/api/tests/pglite-test-db");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  await db.transaction(
    async (tx) =>
      // SAFETY: pglite's transaction stands in for the one the helper expects.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite transaction is the test's transaction
      await callback(tx as unknown as Transaction),
  );

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);

afterAll(async () => {
  await client.close();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_SLICE = "2026-01-01";
const NOW = new Date("2026-02-01T12:00:00.000Z");
const FROM = new Date("2026-01-01T00:00:00.000Z");
const TO = new Date("2026-01-06T00:00:00.000Z");
const PAGE_SIZE = 2;
const INTERVAL_MS = 250;

/**
 * Per slice, the identities the fake publisher lists, in listing order. It
 * repeats one, lists an unkeyable item, and has an empty day, so the count is
 * the distinct keyable identities and not the rows.
 */
const LISTED: Record<string, readonly (string | null)[]> = {
  "2026-01-01": ["a", "b", "c"],
  "2026-01-02": ["d", "d", null],
  "2026-01-03": [],
  "2026-01-04": ["e", "f", "g", "h", "i"],
  "2026-01-05": ["j"],
  "2026-01-06": ["k", "l"],
};
const EXPECTED_TOTAL = 12;
const SLICE_COUNT = Object.keys(LISTED).length;

const stepDay = (slice: string, days: number): string =>
  toUtcDateString(
    new Date(new Date(`${slice}T00:00:00.000Z`).getTime() + days * DAY_MS),
  );

const itemFor = (id: string | null): ReconciliationListingItem =>
  id === null
    ? { identity: { type: "unidentifiable" }, payload: null }
    : { identity: { type: "document", sourceDocumentId: id }, payload: { id } };

type FakePublisher = {
  adapter: ListingCensusAdapter;
  /** Every slice-page request, in order. */
  requests: string[];
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
};

type FakePublisherOptions = {
  key: string;
  /** Throw on the first request for this slice, once. */
  failOnce?: string | undefined;
  /** Runs before a slice's first page is answered. */
  beforeSlice?: ((slice: string) => Promise<void>) | undefined;
  listed?: Record<string, readonly (string | null)[]> | undefined;
};

const fakePublisher = ({
  beforeSlice,
  failOnce,
  key,
  listed = LISTED,
}: FakePublisherOptions): FakePublisher => {
  const requests: string[] = [];
  const sleeps: number[] = [];
  let pendingFailure = failOnce;
  const tip = toUtcDateString(NOW);
  return {
    requests,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      await Promise.resolve();
    },
    adapter: {
      key,
      minRequestIntervalMs: INTERVAL_MS,
      pageTimeoutMs: 1000,
      reconciliation: {
        firstSlice: FIRST_SLICE,
        sliceOf: toUtcDateString,
        nextSlice: (slice) => {
          const next = stepDay(slice, 1);
          return next > tip ? null : next;
        },
        previousSlice: (slice) => {
          const previous = stepDay(slice, -1);
          return previous < FIRST_SLICE ? null : previous;
        },
        tipWindowDays: 1,
        listSlicePage: async ({ page, slice }) => {
          requests.push(`${slice}#${page}`);
          if (page === 0) {
            await beforeSlice?.(slice);
          }
          if (pendingFailure === slice) {
            pendingFailure = undefined;
            throw new Error("publisher unavailable");
          }
          const ids = listed[slice] ?? [];
          return {
            items: ids
              .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
              .map(itemFor),
            totalPages: Math.ceil(ids.length / PAGE_SIZE),
          };
        },
        buildDecision: async () =>
          await Promise.resolve({ type: "unkeyable" as const }),
      },
    },
  };
};

const seedSource = async (): Promise<string> => {
  const id = createSafeId<"caseLawSource">();
  const adapterKey = `census-${id}`;
  await db.insert(caseLawSources).values({
    id,
    adapterKey,
    name: "listing census fixture",
    config: { reconciliation: { firstSlice: FIRST_SLICE } },
  });
  return adapterKey;
};

const readSource = async (adapterKey: string) => {
  const row = (
    await db
      .select({
        config: caseLawSources.config,
        reportedTotal: caseLawSources.reportedTotal,
        reportedTotalAsOf: caseLawSources.reportedTotalAsOf,
        reportedTotalOrigin: caseLawSources.reportedTotalOrigin,
      })
      .from(caseLawSources)
      .where(eq(caseLawSources.adapterKey, adapterKey))
  ).at(0);
  return row ?? panic(`no fixture row for ${adapterKey}`);
};

type RunOptions = {
  publisher: FakePublisher;
  maxSlices: number;
  /** Absent: `TO`. `null`: no end, so the call adopts the stored census. */
  to?: Date | null | undefined;
  now?: Date | undefined;
};

const run = async ({ maxSlices, now = NOW, publisher, to = TO }: RunOptions) =>
  await runListingCensus({
    scopedDb,
    adapter: publisher.adapter,
    from: FROM,
    to: to ?? undefined,
    now,
    maxSlices,
    sleep: publisher.sleep,
  });

const unwrap = <T, E>(result: Result<T, E>): T =>
  Result.isError(result)
    ? panic(`expected ok, got ${String(result.error)}`)
    : result.value;

/** Run to the end in calls of `perCall` slices; returns each call's outcome. */
const runToEnd = async (publisher: FakePublisher, perCall: number) => {
  const outcomes: string[] = [];
  for (let call = 0; call <= SLICE_COUNT; call += 1) {
    const outcome = unwrap(await run({ publisher, maxSlices: perCall }));
    outcomes.push(outcome.type);
    if (outcome.type !== "counting") {
      return outcomes;
    }
  }
  throw new Error("census did not finish within one call per slice");
};

describe("runListingCensus", () => {
  test("an uninterrupted run writes the sum of distinct keyable identities", async () => {
    const adapterKey = await seedSource();
    const publisher = fakePublisher({ key: adapterKey });

    const outcome = unwrap(
      await run({ publisher, maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN }),
    );

    expect(outcome).toEqual({
      type: "completed",
      slicesThisRun: SLICE_COUNT,
      checkpoint: {
        status: LISTING_CENSUS_STATUS.COMPLETE,
        fromSlice: "2026-01-01",
        toSlice: "2026-01-06",
        asOf: TO.toISOString(),
        slicesCounted: SLICE_COUNT,
        total: EXPECTED_TOTAL,
        lastSliceCount: 2,
      },
    });
    const row = await readSource(adapterKey);
    expect(row.reportedTotal).toBe(EXPECTED_TOTAL);
    expect(row.reportedTotalAsOf).toEqual(TO);
    expect(row.reportedTotalOrigin).toBe(SOURCE_TOTAL_ORIGIN.LISTING_CENSUS);
    // The operator's policy beside the checkpoint is left as it was.
    expect(row.config?.["reconciliation"]).toEqual({ firstSlice: FIRST_SLICE });
    // Paced at the adapter's interval: between slices, and between the pages
    // of the one slice that has several.
    expect(publisher.sleeps.every((ms) => ms === INTERVAL_MS)).toBe(true);
    expect(publisher.sleeps).toHaveLength(publisher.requests.length - 1);
  });

  test("a partial run writes no total and leaves a resumable checkpoint", async () => {
    const adapterKey = await seedSource();
    const publisher = fakePublisher({ key: adapterKey });

    const outcome = unwrap(await run({ publisher, maxSlices: 2 }));

    const checkpoint = {
      status: LISTING_CENSUS_STATUS.COUNTING,
      fromSlice: "2026-01-01",
      toSlice: "2026-01-06",
      asOf: TO.toISOString(),
      slicesCounted: 2,
      nextSlice: "2026-01-03",
      counted: 4,
    };
    expect(outcome).toEqual({ type: "counting", slicesThisRun: 2, checkpoint });
    const row = await readSource(adapterKey);
    expect(row.reportedTotal).toBeNull();
    expect(row.reportedTotalOrigin).toBeNull();
    expect(row.config?.[LISTING_CENSUS_CONFIG_KEY]).toEqual(checkpoint);
  });

  test.each([1, 2, 3, 5])(
    "calls of %i slices reach the uninterrupted result",
    async (perCall) => {
      const adapterKey = await seedSource();
      const publisher = fakePublisher({ key: adapterKey });

      const outcomes = await runToEnd(publisher, perCall);

      expect(outcomes.at(-1)).toBe("completed");
      expect(outcomes.filter((type) => type === "completed")).toHaveLength(1);
      expect((await readSource(adapterKey)).reportedTotal).toBe(EXPECTED_TOTAL);
      // Every slice was listed exactly once across the calls.
      expect(
        publisher.requests.filter((request) => request.endsWith("#0")),
      ).toHaveLength(SLICE_COUNT);
    },
  );

  test.each(Object.keys(LISTED))(
    "a listing failure at %s resumes to the same fixed point",
    async (failing) => {
      const adapterKey = await seedSource();
      const publisher = fakePublisher({ key: adapterKey, failOnce: failing });

      const interrupted = await run({
        publisher,
        maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN,
      });
      expect(Result.isError(interrupted)).toBe(true);
      if (Result.isError(interrupted)) {
        expect(interrupted.error).toBeInstanceOf(AdapterFetchError);
      }
      const held = await readSource(adapterKey);
      expect(held.reportedTotal).toBeNull();
      // The checkpoint stops at the failing slice, with everything before it.
      const checkpoint = held.config?.[LISTING_CENSUS_CONFIG_KEY];
      if (failing !== FIRST_SLICE) {
        expect(checkpoint).toMatchObject({ nextSlice: failing });
      }

      const resumed = unwrap(
        await run({ publisher, maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN }),
      );
      expect(resumed.type).toBe("completed");
      const row = await readSource(adapterKey);
      expect(row.reportedTotal).toBe(EXPECTED_TOTAL);
      expect(row.config?.[LISTING_CENSUS_CONFIG_KEY]).toMatchObject({
        status: LISTING_CENSUS_STATUS.COMPLETE,
        total: EXPECTED_TOTAL,
        slicesCounted: SLICE_COUNT,
      });
    },
  );

  test("re-running a complete census lists nothing and writes nothing", async () => {
    const adapterKey = await seedSource();
    const publisher = fakePublisher({ key: adapterKey });
    unwrap(
      await run({ publisher, maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN }),
    );
    // Stand in for a figure recorded since: a second write would replace it.
    await db
      .update(caseLawSources)
      .set({ reportedTotal: 999 })
      .where(eq(caseLawSources.adapterKey, adapterKey));
    const before = await readSource(adapterKey);
    const requestsBefore = publisher.requests.length;

    const explicit = unwrap(await run({ publisher, maxSlices: 1 }));

    expect(explicit.type).toBe("already-complete");
    expect(publisher.requests).toHaveLength(requestsBefore);
    expect(await readSource(adapterKey)).toEqual(before);
  });

  test("an open-ended census whose tip has not moved is a no-op", async () => {
    const adapterKey = await seedSource();
    const publisher = fakePublisher({ key: adapterKey });
    const atTip = new Date("2026-01-06T12:00:00.000Z");
    unwrap(
      await run({
        publisher,
        maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN,
        to: null,
        now: atTip,
      }),
    );
    const requestsBefore = publisher.requests.length;

    const again = unwrap(
      await run({ publisher, maxSlices: 1, to: null, now: atTip }),
    );

    expect(again.type).toBe("already-complete");
    expect(publisher.requests).toHaveLength(requestsBefore);
  });

  test("an open-ended run after the tip moved extends the census and rewrites the total", async () => {
    const adapterKey = await seedSource();
    const listed = { ...LISTED };
    const publisher = fakePublisher({ key: adapterKey, listed });
    unwrap(
      await run({ publisher, maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN }),
    );
    // The old end day was still the tip when counted and has grown since; a
    // later day now lists too.
    listed["2026-01-06"] = ["k", "l", "m"];
    listed["2026-01-07"] = ["n"];
    const requestsBefore = publisher.requests.length;

    const plan = unwrap(
      await inspectListingCensus({
        scopedDb,
        adapter: publisher.adapter,
        from: FROM,
        now: NOW,
      }),
    );
    expect(plan.start.type).toBe("extend");
    const outcome = unwrap(
      await run({
        publisher,
        maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN,
        to: null,
      }),
    );

    expect(outcome.type).toBe("completed");
    const row = await readSource(adapterKey);
    expect(row.reportedTotal).toBe(EXPECTED_TOTAL - 2 + 3 + 1);
    expect(row.reportedTotalAsOf).toEqual(NOW);
    // Listing resumed at the old end day; nothing before it was listed again.
    const extension = publisher.requests.slice(requestsBefore);
    expect(extension.at(0)).toBe("2026-01-06#0");
    expect(extension.some((request) => request < "2026-01-06")).toBe(false);
    expect(row.config?.[LISTING_CENSUS_CONFIG_KEY]).toMatchObject({
      status: LISTING_CENSUS_STATUS.COMPLETE,
      toSlice: toUtcDateString(NOW),
      slicesCounted: 32,
    });
  });

  test("a later observation of the same end day recounts that day", async () => {
    const adapterKey = await seedSource();
    const listed = { ...LISTED };
    const publisher = fakePublisher({ key: adapterKey, listed });
    unwrap(
      await run({ publisher, maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN }),
    );
    listed["2026-01-06"] = ["k", "l", "m"];
    const requestsBefore = publisher.requests.length;
    const evening = new Date("2026-01-06T18:00:00.000Z");

    const outcome = unwrap(await run({ publisher, maxSlices: 1, to: evening }));

    expect(outcome).toMatchObject({
      type: "completed",
      slicesThisRun: 1,
      checkpoint: { total: EXPECTED_TOTAL + 1, asOf: evening.toISOString() },
    });
    expect(publisher.requests.slice(requestsBefore)).toEqual([
      "2026-01-06#0",
      "2026-01-06#1",
    ]);
    const row = await readSource(adapterKey);
    expect(row.reportedTotal).toBe(EXPECTED_TOTAL + 1);
    expect(row.reportedTotalAsOf).toEqual(evening);
  });

  test("the floor is the publisher's first slice or the configured sweep floor", async () => {
    const adapterKey = await seedSource();
    await db
      .update(caseLawSources)
      .set({ config: { reconciliation: { firstSlice: "2026-01-03" } } })
      .where(eq(caseLawSources.adapterKey, adapterKey));
    const publisher = fakePublisher({ key: adapterKey });

    const between = await runListingCensus({
      scopedDb,
      adapter: publisher.adapter,
      from: new Date("2026-01-02T00:00:00.000Z"),
      to: TO,
      now: NOW,
      maxSlices: 3,
      sleep: publisher.sleep,
    });
    expect(Result.isError(between)).toBe(true);
    expect(publisher.requests).toHaveLength(0);

    // No floor given: the configured sweep floor.
    const floored = unwrap(
      await runListingCensus({
        scopedDb,
        adapter: publisher.adapter,
        to: TO,
        now: NOW,
        maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN,
        sleep: publisher.sleep,
      }),
    );
    expect(floored).toMatchObject({
      type: "completed",
      checkpoint: { fromSlice: "2026-01-03", total: 8 },
    });
  });

  test("without an end, a call resumes the stored census rather than restarting", async () => {
    const adapterKey = await seedSource();
    const publisher = fakePublisher({ key: adapterKey });
    unwrap(await run({ publisher, maxSlices: 2 }));

    const resumed = unwrap(
      await run({
        publisher,
        maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN,
        to: null,
      }),
    );

    expect(resumed.type).toBe("completed");
    expect((await readSource(adapterKey)).reportedTotalAsOf).toEqual(TO);
  });

  test("a different end restarts the census from the floor", async () => {
    const adapterKey = await seedSource();
    const publisher = fakePublisher({ key: adapterKey });
    unwrap(
      await run({ publisher, maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN }),
    );
    const shorter = new Date("2026-01-02T00:00:00.000Z");

    const plan = unwrap(
      await inspectListingCensus({
        scopedDb,
        adapter: publisher.adapter,
        from: FROM,
        to: shorter,
        now: NOW,
      }),
    );
    expect(plan.start.type).toBe("restart");

    const outcome = unwrap(
      await run({
        publisher,
        maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN,
        to: shorter,
      }),
    );
    expect(outcome).toMatchObject({
      type: "completed",
      checkpoint: { total: 4 },
    });
    const row = await readSource(adapterKey);
    expect(row.reportedTotal).toBe(4);
    expect(row.reportedTotalAsOf).toEqual(shorter);
  });

  test("a call whose checkpoint moved underneath it stops without writing", async () => {
    const adapterKey = await seedSource();
    const rival = {
      status: LISTING_CENSUS_STATUS.COUNTING,
      fromSlice: "2026-01-01",
      toSlice: "2026-01-06",
      asOf: TO.toISOString(),
      slicesCounted: 3,
      nextSlice: "2026-01-04",
      counted: 7,
    };
    const publisher = fakePublisher({
      key: adapterKey,
      // Another call advances the checkpoint while this one is listing.
      beforeSlice: async (slice) => {
        if (slice !== "2026-01-02") {
          return;
        }
        await db
          .update(caseLawSources)
          .set({
            config: sql`jsonb_set(${caseLawSources.config}, ${`{${LISTING_CENSUS_CONFIG_KEY}}`}::text[], ${JSON.stringify(rival)}::text::jsonb)`,
          })
          .where(eq(caseLawSources.adapterKey, adapterKey));
      },
    });

    const outcome = unwrap(
      await run({ publisher, maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN }),
    );

    expect(outcome).toEqual({ type: "superseded", slicesThisRun: 1 });
    const row = await readSource(adapterKey);
    expect(row.config?.[LISTING_CENSUS_CONFIG_KEY]).toEqual(rival);
    expect(row.reportedTotal).toBeNull();
  });

  test("a range that lists nothing completes without a total", async () => {
    const adapterKey = await seedSource();
    const publisher = fakePublisher({ key: adapterKey, listed: {} });

    const outcome = unwrap(
      await run({ publisher, maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN }),
    );
    expect(outcome.type).toBe("nothing-listed");
    expect((await readSource(adapterKey)).reportedTotal).toBeNull();
    expect(unwrap(await run({ publisher, maxSlices: 1 })).type).toBe(
      "already-complete",
    );
  });

  test.each([
    ["a budget of zero", { maxSlices: 0 }],
    [
      "a budget above the cap",
      { maxSlices: MAX_LISTING_CENSUS_SLICES_PER_RUN + 1 },
    ],
    ["an end in the future", { to: new Date("2026-03-01T00:00:00.000Z") }],
    ["an end before the floor", { to: new Date("2025-12-31T00:00:00.000Z") }],
    [
      "a floor before the first slice",
      { from: new Date("2025-12-31T00:00:00.000Z") },
    ],
  ])("refuses %s before contacting the publisher", async (_, override) => {
    const adapterKey = await seedSource();
    const publisher = fakePublisher({ key: adapterKey });

    const result = await runListingCensus({
      scopedDb,
      adapter: publisher.adapter,
      from: FROM,
      to: TO,
      now: NOW,
      maxSlices: 3,
      sleep: publisher.sleep,
      ...override,
    });

    expect(Result.isError(result)).toBe(true);
    expect(publisher.requests).toHaveLength(0);
    expect(
      (await readSource(adapterKey)).config?.[LISTING_CENSUS_CONFIG_KEY],
    ).toBeUndefined();
  });

  test("refuses a malformed stored checkpoint rather than overwriting it", async () => {
    const adapterKey = await seedSource();
    await db
      .update(caseLawSources)
      .set({ config: { [LISTING_CENSUS_CONFIG_KEY]: { status: "counting" } } })
      .where(eq(caseLawSources.adapterKey, adapterKey));
    const publisher = fakePublisher({ key: adapterKey });

    const result = await run({ publisher, maxSlices: 3 });

    expect(Result.isError(result)).toBe(true);
    expect(publisher.requests).toHaveLength(0);
  });
});
