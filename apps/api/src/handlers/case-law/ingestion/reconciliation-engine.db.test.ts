import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DAY_IN_MS } from "@stll/time";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCoverageSlices,
  caseLawDecisions,
  caseLawReconciliationItems,
  caseLawSources,
  RECONCILIATION_ITEM_STATUS,
  relations,
} from "@/api/db/schema";
import type { SliceRetrySchedule } from "@/api/handlers/case-law/ingestion/reconciliation-engine";
import {
  MAX_SLICE_INGEST_BUDGET,
  RECONCILIATION_INGEST_BUDGET_MS,
  runReconciliationWorkUnit,
} from "@/api/handlers/case-law/ingestion/reconciliation-engine";
import {
  RECONCILIATION_FAILED_SLICE_RETRY_MS,
  RECONCILIATION_SETTLED_RECHECK_MS,
  SLICE_WALK_REASON,
} from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { addUtcDays, toUtcDateString } from "@/api/lib/dates";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import {
  EMPTY_AST,
  listingIdentityKey,
} from "@/api/lib/legal-search/ingestion-types";
import type {
  IngestionResult,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceReconciliation,
} from "@/api/lib/legal-search/ingestion-types";

// A settled short slice is short forever — that is what settled means — so it
// is never re-walked and its `checkedAt` never moves on its own. The candidate
// read is a bounded oldest-first window, so without a deliberate touch enough
// settled rows fill that window permanently and every slice behind them stops
// being reachable: priority 3 dies while the loop still reports itself busy.
//
// Neither half of that is visible in a unit test of the selection, because the
// starvation is a property of the ledger read plus the window size. It is
// asserted here against real rows: a full window of settled slices hiding one
// that still owes decisions, and the owed one surfacing on the next unit.

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

const { createTestPglite } = await import("@/api/tests/pglite-test-db");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the engine expects.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);

afterAll(async () => {
  await client.close();
});

/**
 * Slices are the real thing: UTC days, keyed off the clock the engine reads,
 * so the staleness arithmetic under test is the production arithmetic.
 */
const NOW = new Date();
const day = (offset: number): string =>
  toUtcDateString(addUtcDays(NOW, offset));
const stepDay = (slice: string, offset: number): string =>
  toUtcDateString(addUtcDays(new Date(`${slice}T00:00:00.000Z`), offset));

/** Matches SHORT_SLICE_CANDIDATES in the engine: one full candidate window. */
const WINDOW = 25;

const TIP_WINDOW_DAYS = 2;
/** The one slice that still owes decisions; also the feed's first slice. */
const OWED_SLICE = day(-(WINDOW + 2));
/** A full window of slices that look short but owe nothing. */
const SETTLED_SLICES = Array.from({ length: WINDOW }, (_, index) =>
  day(-(index + TIP_WINDOW_DAYS)),
);

const listed: ReconciliationSlicePageOptions[] = [];

const DOCUMENT_KEYS = [
  "2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23",
  "6b1c4e57-2d38-4f19-9a02-71f5c8d3e004",
].map(
  (sourceDocumentId) =>
    listingIdentityKey({ type: "document", sourceDocumentId }) ?? "",
);

const LISTING_ITEMS = [
  {
    jednaciCislo: "11 C 153/2025-38",
    soud: "Krajský soud v Brně",
    odkaz:
      "https://rozhodnuti.justice.cz/api/finaldoc/2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23",
  },
  {
    jednaciCislo: "31 Cm 8/2024-102",
    soud: "Krajský soud v Ostravě",
    odkaz:
      "https://rozhodnuti.justice.cz/api/finaldoc/6b1c4e57-2d38-4f19-9a02-71f5c8d3e004",
  },
] as const;

/** Real dockets, so the fallback identity key is the shape the ledger keys. */
const FIXTURE_CASE_NUMBERS = ["11 C 153/2025", "31 Cm 8/2024"] as const;
const FIXTURE_COURT = "Krajský soud v Brně";
const FIXTURE_LANGUAGE = "cs";

/**
 * A publisher that lists two decisions and serves neither document. Enough to
 * drive a real walk without a pipeline write: what is under test is which
 * slice the engine chose, not what it stored.
 */
/** Page count the stub claims; overridden per test to drive the page cap. */
const listing = { totalPages: 1 };

/** Every payload the engine asked to build, so a test can assert none was. */
const builds: unknown[] = [];

// Both arrays are module state the stub writes to, and tests assert their
// exact contents. Reset per test so the order tests run in cannot decide
// whether they pass.
beforeEach(() => {
  listed.length = 0;
  builds.length = 0;
  listing.totalPages = 1;
});

const stubReconciliation: SourceReconciliation = {
  firstSlice: OWED_SLICE,
  sliceOf: toUtcDateString,
  nextSlice: (slice) => {
    const next = stepDay(slice, 1);
    return next > toUtcDateString(new Date()) ? null : next;
  },
  previousSlice: (slice) => {
    const previous = stepDay(slice, -1);
    return previous < OWED_SLICE ? null : previous;
  },
  tipWindowDays: TIP_WINDOW_DAYS,
  listSlicePage: async (options): Promise<ReconciliationSlicePage> => {
    listed.push(options);
    return await Promise.resolve({
      items: LISTING_ITEMS.map((item) => ({
        identity: {
          type: "document",
          sourceDocumentId: item.odkaz.split("/").at(-1) ?? "",
        },
        payload: item,
      })),
      totalPages: listing.totalPages,
    });
  },
  buildDecision: async (payload) => {
    builds.push(payload);
    return await Promise.resolve({ type: "detail-unavailable" });
  },
};

/** The same publisher, with one slice it will not serve. */
const unwalkableSliceStub: SourceReconciliation = {
  ...stubReconciliation,
  listSlicePage: async (options): Promise<ReconciliationSlicePage> => {
    listed.push(options);
    if (options.slice === OWED_SLICE) {
      throw new AdapterFetchError({
        message: "listing refused",
        adapterKey: "engine-fixture",
        cursor: options.slice,
      });
    }
    return await Promise.resolve({ items: [], totalPages: 1 });
  },
};

/**
 * The same publisher, with a build that fails the way a database driver does:
 * the whole failed statement in the outer message and the SQLSTATE one
 * `cause` hop down, which is the shape a query wrapper produces.
 */
const drivenFailureStub: SourceReconciliation = {
  ...stubReconciliation,
  buildDecision: async () => {
    const cause = Object.assign(new Error('column "reason" does not exist'), {
      errno: "42703",
    });
    return await Promise.reject(
      new Error(`Failed query: select ${"a, ".repeat(300)}from x`, { cause }),
    );
  },
};

/**
 * The same publisher, listing dockets instead of document ids: the other half
 * of the identity index, which is answered by its own held query.
 */
const caseNumberStub: SourceReconciliation = {
  ...stubReconciliation,
  listSlicePage: async (options): Promise<ReconciliationSlicePage> => {
    listed.push(options);
    return await Promise.resolve({
      items: FIXTURE_CASE_NUMBERS.map((caseNumber) => ({
        identity: {
          type: "case-number",
          caseNumber,
          language: FIXTURE_LANGUAGE,
        },
        payload: { caseNumber },
      })),
      totalPages: listing.totalPages,
    });
  },
};

const seedSource = async (): Promise<SafeId<"caseLawSource">> => {
  const id = createSafeId<"caseLawSource">();
  await db
    .insert(caseLawSources)
    .values({ id, adapterKey: `reconciliation-${id}`, name: "engine fixture" });
  return id;
};

type SeedSliceInput = {
  sourceId: SafeId<"caseLawSource">;
  slice: string;
  reported: number;
  collected: number;
  checkedAt: Date;
};

const seedSlice = async ({
  sourceId,
  slice,
  reported,
  collected,
  checkedAt,
}: SeedSliceInput): Promise<void> => {
  await db.insert(caseLawCoverageSlices).values({
    id: createSafeId<"caseLawCoverageSlice">(),
    sourceId,
    slice,
    reported,
    collected,
    checkedAt,
  });
};

/** A retired item, which is what makes a short slice settled. */
const seedTerminalItem = async (
  sourceId: SafeId<"caseLawSource">,
  slice: string,
): Promise<void> => {
  await db.insert(caseLawReconciliationItems).values({
    id: createSafeId<"caseLawReconciliationItem">(),
    sourceId,
    slice,
    identityKey:
      listingIdentityKey({ type: "document", sourceDocumentId: slice }) ??
      slice,
    payload: {},
    status: RECONCILIATION_ITEM_STATUS.TERMINAL,
    attempts: 6,
    nextAttemptAt: null,
  });
};

const checkedAtBySlice = async (
  sourceId: SafeId<"caseLawSource">,
  slices: readonly string[],
): Promise<Map<string, Date>> =>
  new Map(
    (
      await db
        .select({
          slice: caseLawCoverageSlices.slice,
          checkedAt: caseLawCoverageSlices.checkedAt,
        })
        .from(caseLawCoverageSlices)
        .where(
          and(
            eq(caseLawCoverageSlices.sourceId, sourceId),
            inArray(caseLawCoverageSlices.slice, [...slices]),
          ),
        )
        .limit(slices.length)
    ).map(({ slice, checkedAt }) => [slice, checkedAt]),
  );

type RunUnitOptions = {
  sourceId: SafeId<"caseLawSource">;
  reconciliation?: SourceReconciliation;
  sliceIngestBudget?: number;
  /** Shared across turns only where a test is about what a failure leaves. */
  sliceRetries?: SliceRetrySchedule;
  /** Frozen unless a test is about the unit's own wall-clock budget. */
  now?: () => Date;
  /** Instant unless a test needs the politeness pause to consume the budget. */
  sleep?: (ms: number) => Promise<void>;
};

const runUnitWith = async ({
  now = () => NOW,
  reconciliation = stubReconciliation,
  sleep = async () => {
    await Promise.resolve();
  },
  sliceIngestBudget,
  sliceRetries = new Map(),
  sourceId,
}: RunUnitOptions) =>
  await runReconciliationWorkUnit({
    adapterKey: "engine-fixture",
    sourceId,
    reconciliation,
    scopedDb,
    now,
    fetchDelayMs: 0,
    sleep,
    sliceIngestBudget,
    sliceRetries,
  });

const runUnit = async (
  sourceId: SafeId<"caseLawSource">,
  reconciliation: SourceReconciliation = stubReconciliation,
) => await runUnitWith({ sourceId, reconciliation });

test("a settled slice is touched out of the window so the one behind it is reached", async () => {
  const sourceId = await seedSource();

  // The tip is already fresh, so priority 2 never fires and the short-slice
  // arm is what the unit actually exercises.
  const staleAt = addUtcDays(NOW, -30);
  for (const offset of [0, -1]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedSlice({
      sourceId,
      slice: day(offset),
      reported: 0,
      collected: 0,
      checkedAt: NOW,
    });
  }

  // A full candidate window of slices that are short on paper and settled in
  // fact, every one checked longer ago than the slice that still owes work.
  for (const slice of SETTLED_SLICES) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedSlice({
      sourceId,
      slice,
      reported: 2,
      collected: 1,
      checkedAt: staleAt,
    });
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedTerminalItem(sourceId, slice);
  }

  // Stale, but newer than all of them, so it sorts 26th in an oldest-first
  // read of 25 rows: invisible until the settled ones move.
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 2,
    collected: 1,
    checkedAt: addUtcDays(NOW, -2),
  });

  const before = await checkedAtBySlice(sourceId, SETTLED_SLICES);

  // The first unit sees nothing but settled rows. It must not walk one, and
  // must not report work it did not do.
  const first = await runUnit(sourceId);
  expect(first).toEqual({ type: "idle" });
  expect(listed).toEqual([]);

  // …but it did move every one of them out of the stale window.
  const after = await checkedAtBySlice(sourceId, SETTLED_SLICES);
  expect(after.size).toBe(WINDOW);
  for (const slice of SETTLED_SLICES) {
    const advanced =
      (after.get(slice)?.getTime() ?? 0) > (before.get(slice)?.getTime() ?? 0);
    expect({ slice, advanced }).toEqual({ slice, advanced: true });
  }
  // Touching is bookkeeping, not a rewrite: the counts are unchanged, so the
  // rows still read as short and are re-examined once they age again.
  const [untouchedCounts] = await db
    .select({
      reported: caseLawCoverageSlices.reported,
      collected: caseLawCoverageSlices.collected,
    })
    .from(caseLawCoverageSlices)
    .where(
      and(
        eq(caseLawCoverageSlices.sourceId, sourceId),
        eq(caseLawCoverageSlices.slice, SETTLED_SLICES[0] ?? ""),
      ),
    )
    .limit(1);
  expect(untouchedCounts).toEqual({ reported: 2, collected: 1 });

  // The next unit's window is no longer full of settled rows, so the slice
  // that actually owes decisions is finally selected and walked.
  const second = await runUnit(sourceId);
  expect(second).toMatchObject({
    type: "worked",
    summary: {
      unit: "slice",
      slice: OWED_SLICE,
      reason: SLICE_WALK_REASON.SHORT,
    },
  });
  expect(listed.map(({ slice }) => slice)).toEqual([OWED_SLICE]);
});

test("a walk ingests no more than the unit's slice budget and defers the rest", async () => {
  // Two listed misses, a budget of one: the walk fetches one and records the
  // other as deferred, so the slice stays short and is selected again.
  const sourceId = await seedSource();
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 2,
    collected: 0,
    checkedAt: addUtcDays(NOW, -2),
  });
  for (const offset of [0, -1]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedSlice({
      sourceId,
      slice: day(offset),
      reported: 0,
      collected: 0,
      checkedAt: NOW,
    });
  }

  const outcome = await runUnitWith({ sourceId, sliceIngestBudget: 1 });

  expect(outcome).toMatchObject({
    type: "worked",
    summary: { slice: OWED_SLICE, keyable: 2, parked: 1, deferred: 1 },
  });
  expect(builds).toHaveLength(1);
});

/**
 * A clock the publisher moves: the unit's budget is wall-clock, and only a
 * publisher that takes time to answer can exhaust it. Each response ages the
 * clock by `stepMs`, so a test places the expiry at an exact point in the walk
 * instead of guessing at real durations.
 */
const publisherPacedClock = (stepMs: number) => {
  let atMs = NOW.getTime();
  return {
    now: () => new Date(atMs),
    age: () => {
      atMs += stepMs;
    },
  };
};

test("a walk out of clock defers the rest of its budget rather than overrunning", async () => {
  // The count budget is untouched here: two listed misses and room for fifty.
  // What stops the walk is the unit's own wall clock, and the miss it did not
  // reach has to be owed exactly as a count-deferred one is, or the slice
  // records collected as if it had been fully walked.
  const sourceId = await seedSource();
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 2,
    collected: 0,
    checkedAt: addUtcDays(NOW, -2),
  });
  for (const offset of [0, -1]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedSlice({
      sourceId,
      slice: day(offset),
      reported: 0,
      collected: 0,
      checkedAt: NOW,
    });
  }

  // One document costs the whole budget, so the walk has the clock for the
  // first miss and not for the second.
  const clock = publisherPacedClock(RECONCILIATION_INGEST_BUDGET_MS + 1);
  const outcome = await runUnitWith({
    sourceId,
    now: clock.now,
    reconciliation: {
      ...stubReconciliation,
      buildDecision: async (payload) => {
        builds.push(payload);
        clock.age();
        return await Promise.resolve({ type: "detail-unavailable" });
      },
    },
  });

  expect(outcome).toMatchObject({
    type: "worked",
    summary: { slice: OWED_SLICE, keyable: 2, deferred: 1 },
  });
  expect(builds).toHaveLength(1);
});

test("the politeness pause cannot carry a fetch past the budget", async () => {
  // The budget has to guard the request, not the decision to wait: the pause
  // between documents runs on the same clock, so a check taken before it can
  // approve a fetch that only starts after the budget is spent. Two misses and
  // room for fifty, so only the clock can stop this walk -- and it is the
  // pause, not the fetch, that spends it.
  const sourceId = await seedSource();
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 2,
    collected: 0,
    checkedAt: addUtcDays(NOW, -2),
  });
  for (const offset of [0, -1]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedSlice({
      sourceId,
      slice: day(offset),
      reported: 0,
      collected: 0,
      checkedAt: NOW,
    });
  }

  const clock = publisherPacedClock(RECONCILIATION_INGEST_BUDGET_MS + 1);
  const outcome = await runUnitWith({
    sourceId,
    now: clock.now,
    // Only the pause moves the clock here. The first document is fetched
    // inside the budget; the pause before the second exhausts it.
    sleep: async () => {
      clock.age();
      await Promise.resolve();
    },
  });

  expect(outcome).toMatchObject({
    type: "worked",
    summary: { slice: OWED_SLICE, keyable: 2, deferred: 1 },
  });
  expect(builds).toHaveLength(1);
});

test("a slow multi-page listing still completes instead of restarting forever", async () => {
  // The budget deliberately does NOT cut listing off. A listing has nowhere to
  // resume from -- `walkSlice` always starts at page 0 and no page cursor is
  // persisted -- so refusing one on a clock would make a slice that merely
  // lists slowly restart, fail at the same page, and never reconcile at all.
  // Regression guard: this walk spends the whole ingest budget before its
  // second page and must still finish the listing and write coverage.
  const sourceId = await seedSource();
  // Seeded counts differ from what the stub lists, so a coverage row matching
  // the listing proves this walk wrote it rather than leaving the old one.
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 5,
    collected: 3,
    checkedAt: addUtcDays(NOW, -2),
  });
  for (const offset of [0, -1]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedSlice({
      sourceId,
      slice: day(offset),
      reported: 0,
      collected: 0,
      checkedAt: NOW,
    });
  }
  listing.totalPages = 2;

  const clock = publisherPacedClock(RECONCILIATION_INGEST_BUDGET_MS + 1);
  const outcome = await runUnitWith({
    sourceId,
    now: clock.now,
    reconciliation: {
      ...stubReconciliation,
      // Delegating rather than re-listing: the stub already records the call,
      // so this only ages the clock around it.
      listSlicePage: async (options): Promise<ReconciliationSlicePage> => {
        const page = await stubReconciliation.listSlicePage(options);
        clock.age();
        return page;
      },
    },
  });

  // Both pages walk, then ingestion gets its own full phase budget. Starting
  // that clock before listing would defer both misses and repeat the same
  // listing forever.
  expect(listed).toHaveLength(2);
  expect(outcome).toMatchObject({
    type: "worked",
    summary: { slice: OWED_SLICE, listed: 4, keyable: 2, deferred: 0 },
  });
  expect(builds).toHaveLength(2);
  const [coverage] = await db
    .select()
    .from(caseLawCoverageSlices)
    .where(
      and(
        eq(caseLawCoverageSlices.sourceId, sourceId),
        eq(caseLawCoverageSlices.slice, OWED_SLICE),
      ),
    );
  expect(coverage).toMatchObject({ reported: 2, collected: 0 });
});

test("a slice budget outside 1..MAX is refused before any work", async () => {
  const sourceId = await seedSource();
  for (const sliceIngestBudget of [0, MAX_SLICE_INGEST_BUDGET + 1, 1.5]) {
    // Bun's matcher type declares `.rejects.toThrow` as void; capture the
    // rejection explicitly so type-aware lint and the runtime agree.
    // oxlint-disable-next-line no-await-in-loop -- each refusal is asserted in turn
    const rejection: unknown = await runUnitWith({
      sourceId,
      sliceIngestBudget,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({
      message: expect.stringContaining("slice ingest budget"),
    });
  }
  expect(listed).toHaveLength(0);
});

test("a slice the publisher will not serve parks its items rather than storing them", async () => {
  // The same walk, read from the other side: nothing was written, so the
  // slice records collected 0 and stays huntable, and both listed decisions
  // are now carried by the parked store instead of being re-listed forever.
  const sourceId = await seedSource();
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 2,
    collected: 0,
    checkedAt: addUtcDays(NOW, -2),
  });
  for (const offset of [0, -1]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedSlice({
      sourceId,
      slice: day(offset),
      reported: 0,
      collected: 0,
      checkedAt: NOW,
    });
  }

  const outcome = await runUnit(sourceId);

  expect(outcome).toMatchObject({
    type: "worked",
    summary: {
      slice: OWED_SLICE,
      keyable: 2,
      heldBefore: 0,
      written: 0,
      parked: 2,
    },
  });

  const [ledger] = await db
    .select({
      reported: caseLawCoverageSlices.reported,
      collected: caseLawCoverageSlices.collected,
    })
    .from(caseLawCoverageSlices)
    .where(
      and(
        eq(caseLawCoverageSlices.sourceId, sourceId),
        eq(caseLawCoverageSlices.slice, OWED_SLICE),
      ),
    )
    .limit(1);
  expect(ledger).toEqual({ reported: 2, collected: 0 });

  const parked = await db
    .select({ status: caseLawReconciliationItems.status })
    .from(caseLawReconciliationItems)
    .where(eq(caseLawReconciliationItems.sourceId, sourceId))
    .limit(10);
  expect(parked).toEqual([
    { status: RECONCILIATION_ITEM_STATUS.PARKED },
    { status: RECONCILIATION_ITEM_STATUS.PARKED },
  ]);
});

/** A fresh tip, so priority 2 never fires and the short arm is exercised. */
const seedFreshTip = async (
  sourceId: SafeId<"caseLawSource">,
): Promise<void> => {
  for (const offset of [0, -1]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedSlice({
      sourceId,
      slice: day(offset),
      reported: 0,
      collected: 0,
      checkedAt: NOW,
    });
  }
};

const seedItem = async (
  sourceId: SafeId<"caseLawSource">,
  identityKey: string,
  row: {
    status: (typeof RECONCILIATION_ITEM_STATUS)[keyof typeof RECONCILIATION_ITEM_STATUS];
    attempts: number;
    nextAttemptAt: Date | null;
  },
): Promise<void> => {
  await db.insert(caseLawReconciliationItems).values({
    id: createSafeId<"caseLawReconciliationItem">(),
    sourceId,
    slice: OWED_SLICE,
    identityKey,
    payload: {},
    ...row,
  });
};

test("a walk leaves already-tracked identities to the retry path", async () => {
  // The widening backoff is the whole reason a park exists. A tip slice is
  // re-walked daily, so a walk that re-fetched everything it found missing
  // would serve none of that schedule — and would drag terminal items back
  // into the hunt they have already left, which is the unbounded loop the
  // disposition exists to end.
  const sourceId = await seedSource();
  await seedFreshTip(sourceId);
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 2,
    collected: 0,
    checkedAt: addUtcDays(NOW, -2),
  });

  const parkedKey = DOCUMENT_KEYS[0] ?? "";
  const terminalKey = DOCUMENT_KEYS[1] ?? "";
  // One item mid-schedule and not yet due; one already retired.
  await seedItem(sourceId, parkedKey, {
    status: RECONCILIATION_ITEM_STATUS.PARKED,
    attempts: 2,
    nextAttemptAt: new Date(NOW.getTime() + 60 * 60 * 1000),
  });
  await seedItem(sourceId, terminalKey, {
    status: RECONCILIATION_ITEM_STATUS.TERMINAL,
    attempts: 6,
    nextAttemptAt: null,
  });

  const outcome = await runUnit(sourceId);

  // Both listed identities are missing and both are tracked, so the walk
  // fetched neither.
  expect(outcome).toMatchObject({
    type: "worked",
    summary: { slice: OWED_SLICE, keyable: 2, scheduled: 2, deferred: 0 },
  });
  expect(builds).toEqual([]);

  // The parked item's schedule is untouched: no extra attempt was charged.
  const [stillParked] = await db
    .select({
      attempts: caseLawReconciliationItems.attempts,
      status: caseLawReconciliationItems.status,
    })
    .from(caseLawReconciliationItems)
    .where(
      and(
        eq(caseLawReconciliationItems.sourceId, sourceId),
        eq(caseLawReconciliationItems.identityKey, parkedKey),
      ),
    )
    .limit(1);
  expect(stillParked).toEqual({
    attempts: 2,
    status: RECONCILIATION_ITEM_STATUS.PARKED,
  });
});

test("a completed walk drops retired rows the slice no longer lists", async () => {
  // Settledness weighs the terminal count against `reported`/`collected`,
  // which describe the listing as it is now. A retired row for an identity the
  // publisher has since dropped would otherwise keep vouching for a shortfall
  // it has nothing to do with, and could mark a slice settled while a
  // genuinely missing decision sits behind the ingest budget.
  const sourceId = await seedSource();
  await seedFreshTip(sourceId);
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 3,
    collected: 0,
    checkedAt: addUtcDays(NOW, -2),
  });

  const staleTerminalKey =
    listingIdentityKey({
      type: "document",
      sourceDocumentId: "0d9e3a11-7c52-4c88-b6f4-9a1b2c3d4e5f",
    }) ?? "";
  // Retired under this slice, but nowhere in the listing it now returns.
  await seedItem(sourceId, staleTerminalKey, {
    status: RECONCILIATION_ITEM_STATUS.TERMINAL,
    attempts: 6,
    nextAttemptAt: null,
  });

  const outcome = await runUnit(sourceId);

  expect(outcome).toMatchObject({
    type: "worked",
    summary: { slice: OWED_SLICE, pruned: 1 },
  });
  expect(
    await db
      .select({ identityKey: caseLawReconciliationItems.identityKey })
      .from(caseLawReconciliationItems)
      .where(
        and(
          eq(caseLawReconciliationItems.sourceId, sourceId),
          eq(caseLawReconciliationItems.identityKey, staleTerminalKey),
        ),
      )
      .limit(1),
  ).toEqual([]);

  // The two identities the slice does list were parked by this walk and are
  // deliberately kept: they still describe the listing.
  expect(
    await db
      .select({ identityKey: caseLawReconciliationItems.identityKey })
      .from(caseLawReconciliationItems)
      .where(eq(caseLawReconciliationItems.sourceId, sourceId))
      .limit(10),
  ).toHaveLength(2);
});

test("a publisher claiming an absurd page count is refused, not walked", async () => {
  // `totalPages` is the publisher's own number and the response validators
  // only require it to be a number. Unbounded, one wrong value turns a single
  // unit into an endless request sequence that only the runner's hard deadline
  // ends — by killing the process, after which the replacement starts the same
  // walk again.
  const sourceId = await seedSource();
  await seedFreshTip(sourceId);
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 2,
    collected: 0,
    checkedAt: addUtcDays(NOW, -2),
  });

  listing.totalPages = Number.MAX_SAFE_INTEGER;
  // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
  // type-aware lint; capture the rejection explicitly instead.
  const rejection = await runUnit(sourceId).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(AdapterFetchError);

  // It stopped at the ceiling instead of running to the hard deadline.
  expect(listed.length).toBeLessThan(1000);
  expect(listed.length).toBeGreaterThan(1);

  // Nothing was recorded for a listing that was never fully read: the slice
  // keeps its previous row rather than banking a truncated one as complete.
  const [ledger] = await db
    .select({
      reported: caseLawCoverageSlices.reported,
      collected: caseLawCoverageSlices.collected,
    })
    .from(caseLawCoverageSlices)
    .where(
      and(
        eq(caseLawCoverageSlices.sourceId, sourceId),
        eq(caseLawCoverageSlices.slice, OWED_SLICE),
      ),
    )
    .limit(1);
  expect(ledger).toEqual({ reported: 2, collected: 0 });
});

test("a slice the publisher will not serve does not hold the ones behind it", async () => {
  // The other half of the test above. A failed walk writes nothing, so every
  // input the selection reads is exactly what it was before — and the same
  // slice comes back on the next turn, and on every turn after it, while the
  // rest of the source's backlog is never reached. The loop's error backoff
  // does not help: it paces the retries, it does not change what is retried.
  const sourceId = await seedSource();
  await seedFreshTip(sourceId);
  const reachable = stepDay(OWED_SLICE, 1);
  for (const [slice, checkedAt] of [
    [OWED_SLICE, addUtcDays(NOW, -3)],
    [reachable, addUtcDays(NOW, -2)],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedSlice({ sourceId, slice, reported: 2, collected: 0, checkedAt });
  }

  // One schedule across both turns, as the runner holds one per source.
  const sliceRetries: SliceRetrySchedule = new Map();
  const options = {
    sourceId,
    reconciliation: unwalkableSliceStub,
    sliceRetries,
  };

  const rejection = await runUnitWith(options).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(AdapterFetchError);
  expect(listed.map(({ slice }) => slice)).toEqual([OWED_SLICE]);

  // The next turn spends itself on the slice behind it rather than on the one
  // that just refused.
  expect(await runUnitWith(options)).toMatchObject({ type: "worked" });
  expect(listed.map(({ slice }) => slice)).toEqual([OWED_SLICE, reachable]);
});

/** The stub publisher, refusing to list exactly one slice. */
const refusingSlice = (refused: string): SourceReconciliation => ({
  ...stubReconciliation,
  listSlicePage: async (options): Promise<ReconciliationSlicePage> => {
    listed.push(options);
    if (options.slice === refused) {
      throw new AdapterFetchError({
        message: "listing refused",
        adapterKey: "engine-fixture",
        cursor: options.slice,
      });
    }
    return await Promise.resolve({ items: [], totalPages: 1 });
  },
});

test("a slice the publisher will not list is recorded, and the sweep moves past it", async () => {
  // The sweep fills downward from the newest surveyed slice. Without a row
  // for the refused slice it stays the frontier, and the sweep offers it on
  // every turn its hold allows and nothing else in between: one slice the
  // publisher cannot serve ends the survey of everything older. Recording
  // the failure moves the frontier past it.
  const sourceId = await seedSource();
  await seedFreshTip(sourceId);
  const refused = day(-TIP_WINDOW_DAYS);
  const behind = stepDay(refused, -1);
  const options = {
    sourceId,
    reconciliation: refusingSlice(refused),
    sliceRetries: new Map(),
  };

  const rejection = await runUnitWith(options).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(AdapterFetchError);
  expect(await ledgerRow(sourceId, refused)).toEqual({
    reported: null,
    collected: null,
    walkError: "AdapterFetchError: listing refused",
  });

  // The next turn sweeps the slice behind the refused one.
  expect(await runUnitWith(options)).toMatchObject({
    type: "worked",
    summary: { slice: behind, reason: SLICE_WALK_REASON.SWEEP },
  });
  expect(listed.map(({ slice }) => slice)).toEqual([refused, behind]);
});

test("a failed walk of a counted slice keeps its counts and marks it failed", async () => {
  // A short row the backlog owes, whose publisher then refuses it: the row
  // must not lose what the last successful listing said, and it must leave
  // the backlog's window for the retry arm's.
  const sourceId = await seedSource();
  await seedFreshTip(sourceId);
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 2,
    collected: 0,
    checkedAt: addUtcDays(NOW, -2),
  });

  const rejection = await runUnitWith({
    sourceId,
    reconciliation: unwalkableSliceStub,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(AdapterFetchError);
  expect(await ledgerRow(sourceId, OWED_SLICE)).toEqual({
    reported: 2,
    collected: 0,
    walkError: "AdapterFetchError: listing refused",
  });

  // A fresh process (no hold) with the same publisher: the failed row is
  // resting, the backlog no longer offers it, and the source is idle.
  expect(
    await runUnitWith({
      sourceId,
      reconciliation: unwalkableSliceStub,
      sliceRetries: new Map(),
    }),
  ).toEqual({ type: "idle" });
});

test("a failed slice is walked again once it has rested, and a listing clears it", async () => {
  const sourceId = await seedSource();
  await seedFreshTip(sourceId);
  // The feed's first slice, so the sweep has nothing left to offer and the
  // retry arm is what answers the turn.
  await db.insert(caseLawCoverageSlices).values({
    id: createSafeId<"caseLawCoverageSlice">(),
    sourceId,
    slice: OWED_SLICE,
    reported: null,
    collected: null,
    walkError: "AdapterFetchError: listing refused",
    checkedAt: new Date(
      NOW.getTime() - RECONCILIATION_FAILED_SLICE_RETRY_MS - DAY_IN_MS,
    ),
  });

  expect(await runUnit(sourceId)).toMatchObject({
    type: "worked",
    summary: { slice: OWED_SLICE, reason: SLICE_WALK_REASON.RETRY, keyable: 2 },
  });
  // Listed again: counted, no longer failed.
  expect(await ledgerRow(sourceId, OWED_SLICE)).toEqual({
    reported: 2,
    collected: 0,
    walkError: null,
  });
});

test("a failed slice still resting is left alone", async () => {
  const sourceId = await seedSource();
  await seedFreshTip(sourceId);
  await db.insert(caseLawCoverageSlices).values({
    id: createSafeId<"caseLawCoverageSlice">(),
    sourceId,
    slice: OWED_SLICE,
    reported: null,
    collected: null,
    walkError: "AdapterFetchError: listing refused",
    checkedAt: addUtcDays(NOW, 0),
  });

  expect(await runUnit(sourceId)).toEqual({ type: "idle" });
  expect(listed).toHaveLength(0);
});

test("held slices are excluded from the backlog window, not filtered after it", async () => {
  // The backlog read is a bounded oldest-first window. A held row filtered
  // out afterwards still occupies a place in it, so a full window of held
  // rows hides every short slice behind them — the same starvation the
  // settled-row touch exists to prevent, arriving by a different route. The
  // holds renew as they expire, so it does not clear on its own.
  const sourceId = await seedSource();
  await seedFreshTip(sourceId);
  const sliceRetries: SliceRetrySchedule = new Map();
  for (const [index, slice] of SETTLED_SLICES.entries()) {
    sliceRetries.set(slice, NOW.getTime() + DAY_IN_MS);
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedSlice({
      sourceId,
      slice,
      reported: 2,
      collected: 0,
      // Oldest-checked, so these fill the window ahead of the one behind them.
      checkedAt: addUtcDays(NOW, -10 - index),
    });
  }
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 2,
    collected: 0,
    checkedAt: addUtcDays(NOW, -2),
  });
  expect(sliceRetries.size).toBe(SETTLED_SLICES.length);

  expect(await runUnitWith({ sourceId, sliceRetries })).toMatchObject({
    type: "worked",
  });
  expect(listed.map(({ slice }) => slice)).toEqual([OWED_SLICE]);
});

// ── Rechecking a settled slice ──────────────────────────

/**
 * A settled ledger row is the loop's blind spot. It records what the publisher
 * listed on the day of the walk, nothing re-selects it, and a publisher that
 * goes on adding to the slice for months makes that number quietly wrong, with
 * no short row, no parked item and no failure to show for it. Both halves are
 * asserted: that the recheck fires at all, and that it fires only once the row
 * is old enough to be worth an otherwise-idle turn.
 */
const seedSettledHistory = async (
  sourceId: SafeId<"caseLawSource">,
  checkedAt: Date,
): Promise<void> => {
  await seedFreshTip(sourceId);
  // Also the feed's first slice, so the historical sweep is exhausted and
  // cannot answer the turn ahead of the recheck.
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 1,
    collected: 1,
    checkedAt,
  });
};

type LedgerRowRead = {
  reported: number | null;
  collected: number | null;
  walkError: string | null;
};

const ledgerRow = async (
  sourceId: SafeId<"caseLawSource">,
  slice: string,
): Promise<LedgerRowRead | undefined> =>
  (
    await db
      .select({
        reported: caseLawCoverageSlices.reported,
        collected: caseLawCoverageSlices.collected,
        walkError: caseLawCoverageSlices.walkError,
      })
      .from(caseLawCoverageSlices)
      .where(
        and(
          eq(caseLawCoverageSlices.sourceId, sourceId),
          eq(caseLawCoverageSlices.slice, slice),
        ),
      )
      .limit(1)
  ).at(0);

test("a settled slice past the recheck window is re-walked, and a grown listing re-opens it", async () => {
  const sourceId = await seedSource();
  await seedSettledHistory(
    sourceId,
    new Date(NOW.getTime() - RECONCILIATION_SETTLED_RECHECK_MS - DAY_IN_MS),
  );

  const outcome = await runUnit(sourceId);

  expect(outcome).toMatchObject({
    type: "worked",
    summary: {
      unit: "slice",
      slice: OWED_SLICE,
      reason: SLICE_WALK_REASON.RECHECK,
    },
  });
  expect(listed.map(({ slice }) => slice)).toEqual([OWED_SLICE]);

  // The publisher now lists two where the row claimed one, and the walk held
  // neither: the row records short and the slice rejoins the ordinary cycle at
  // priority 3. The recheck itself repairs nothing; it only re-states.
  expect(await ledgerRow(sourceId, OWED_SLICE)).toEqual({
    reported: 2,
    collected: 0,
    walkError: null,
  });
});

test("a held recheck candidate yields to the next settled row, not to idle", async () => {
  // The recheck read is `LIMIT 1` on the oldest settled row, so a held row
  // filtered after the query is the whole candidate set and the source reports
  // idle with a later settled row due. Unlike the sweep frontier, skipping one
  // costs nothing: a settled slice keeps its ledger row and is selectable on a
  // later turn, so the only thing the hold changes is which row this turn
  // proves.
  const sourceId = await seedSource();
  const longSettled = new Date(
    NOW.getTime() - RECONCILIATION_SETTLED_RECHECK_MS - DAY_IN_MS,
  );
  await seedSettledHistory(sourceId, longSettled);
  const behind = stepDay(OWED_SLICE, 1);
  await seedSlice({
    sourceId,
    slice: behind,
    reported: 1,
    collected: 1,
    // Younger than the held row, so it is only reached once that one is out,
    // and still the wrong side of the recheck cutoff so it is genuinely due.
    checkedAt: new Date(longSettled.getTime() + DAY_IN_MS / 2),
  });

  const sliceRetries: SliceRetrySchedule = new Map([
    [OWED_SLICE, NOW.getTime() + DAY_IN_MS],
  ]);

  expect(await runUnitWith({ sourceId, sliceRetries })).toMatchObject({
    type: "worked",
    summary: {
      unit: "slice",
      slice: behind,
      reason: SLICE_WALK_REASON.RECHECK,
    },
  });
  expect(listed.map(({ slice }) => slice)).toEqual([behind]);
});

test("a settled slice inside the recheck window is left alone", async () => {
  // Otherwise proved history is re-walked at nearly the tip's own cadence, and
  // the politeness budget spent on it is budget not spent on slices that are
  // actually short.
  const sourceId = await seedSource();
  await seedSettledHistory(
    sourceId,
    new Date(NOW.getTime() - RECONCILIATION_SETTLED_RECHECK_MS + DAY_IN_MS),
  );

  expect(await runUnit(sourceId)).toEqual({ type: "idle" });
  expect(listed).toEqual([]);
});

// ── Heldness that means detail-held ─────────────────────

/**
 * Metadata exactly as the pipeline writes it, produced by the pipeline's own
 * normalizer rather than spelled out here. The engine's filter reads a path
 * inside this blob; a hand-written stand-in could agree with the filter while
 * both disagreed with the column, and the test would prove nothing.
 */
const storedMetadata = (isListingOnly: boolean): Record<string, unknown> =>
  sanitizeResult({
    caseNumber: FIXTURE_CASE_NUMBERS[0],
    court: FIXTURE_COURT,
    country: "CZE",
    language: FIXTURE_LANGUAGE,
    isListingOnly,
    metadata: {},
    rawHash: "0".repeat(64),
    documentAst: EMPTY_AST,
  } satisfies IngestionResult).metadata;

type SeedDecisionInput = {
  sourceId: SafeId<"caseLawSource">;
  caseNumber: string;
  sourceDocumentId: string | null;
  isListingOnly: boolean;
};

const seedDecision = async ({
  caseNumber,
  isListingOnly,
  sourceDocumentId,
  sourceId,
}: SeedDecisionInput): Promise<void> => {
  await db.insert(caseLawDecisions).values({
    id: createSafeId<"caseLawDecision">(),
    sourceId,
    caseNumber,
    sourceDocumentId,
    court: FIXTURE_COURT,
    country: "CZE",
    language: FIXTURE_LANGUAGE,
    metadata: storedMetadata(isListingOnly),
  });
};

/** A short, stale slice: the walk under test, with no other arm firing. */
const seedWalkableSlice = async (
  sourceId: SafeId<"caseLawSource">,
): Promise<void> => {
  await seedFreshTip(sourceId);
  await seedSlice({
    sourceId,
    slice: OWED_SLICE,
    reported: 2,
    collected: 0,
    checkedAt: addUtcDays(NOW, -2),
  });
};

/** One row per listed document identity; only the second carries detail. */
const seedDocumentIdentityRows = async (
  sourceId: SafeId<"caseLawSource">,
): Promise<void> => {
  for (const [index, item] of LISTING_ITEMS.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedDecision({
      sourceId,
      caseNumber: FIXTURE_CASE_NUMBERS[index] ?? "",
      sourceDocumentId: item.odkaz.split("/").at(-1) ?? "",
      isListingOnly: index === 0,
    });
  }
};

test("a listing-only row is not held where the source requires detail", async () => {
  // Such a row exists because a document fetch failed: the identity is stored
  // and the document is not. Counting it as held is what takes the decision out
  // of every later reconciliation — the slice reads reconciled and nothing ever
  // asks the publisher for the document again.
  const sourceId = await seedSource();
  await seedWalkableSlice(sourceId);
  await seedDocumentIdentityRows(sourceId);

  const outcome = await runUnit(sourceId, {
    ...stubReconciliation,
    heldRequiresDetail: true,
  });

  expect(outcome).toMatchObject({
    type: "worked",
    summary: { slice: OWED_SLICE, keyable: 2, heldBefore: 1, parked: 1 },
  });
  // The stub row was hunted again; the row carrying detail was left alone.
  expect(builds).toHaveLength(1);
});

test("without the declaration both rows count as held, whatever they carry", async () => {
  // The default, and it has to stay the default: a source that ingests
  // metadata first and drains documents later holds a large, legitimately
  // detail-less corpus, and filtering those rows out would report millions of
  // decisions missing and re-ingest every one of them.
  const sourceId = await seedSource();
  await seedWalkableSlice(sourceId);
  await seedDocumentIdentityRows(sourceId);

  expect(await runUnit(sourceId)).toMatchObject({
    type: "worked",
    summary: { slice: OWED_SLICE, keyable: 2, heldBefore: 2, parked: 0 },
  });
  expect(builds).toEqual([]);
});

test("the docket half of the identity index applies the same filter", async () => {
  // Two queries answer "held", one per half of the identity index. A filter
  // added to one and not the other would make heldness mean two things for one
  // source, decided by whether the publisher happened to state a document id.
  const sourceId = await seedSource();
  await seedWalkableSlice(sourceId);
  for (const [index, caseNumber] of FIXTURE_CASE_NUMBERS.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, sequential on one pglite handle
    await seedDecision({
      sourceId,
      caseNumber,
      // The fallback half is exactly the rows stored without a publisher id.
      sourceDocumentId: null,
      isListingOnly: index === 0,
    });
  }

  const outcome = await runUnit(sourceId, {
    ...caseNumberStub,
    heldRequiresDetail: true,
  });

  expect(outcome).toMatchObject({
    type: "worked",
    summary: { slice: OWED_SLICE, keyable: 2, heldBefore: 1, parked: 1 },
  });
  expect(builds).toHaveLength(1);
});

test("a failed item build records the database cause, not just the error tag", async () => {
  // Parking stores the tag alone, so this log line is the only record of why
  // a listed decision could not be built. A driver error spends its whole
  // outer message on the failed statement and carries the SQLSTATE one
  // `cause` hop down: a sink that reads the tag reports "DrizzleQueryError"
  // and nothing an operator can act on.
  const sourceId = await seedSource();
  const realLoggerModule = await import("@/api/lib/observability/logger");
  const warned: Record<string, unknown>[] = [];
  await mock.module("@/api/lib/observability/logger", () => ({
    logger: {
      warn: (_event: string, attributes: Record<string, unknown>) => {
        warned.push(attributes);
      },
      error: () => undefined,
      info: () => undefined,
    },
  }));

  try {
    await runUnit(sourceId, drivenFailureStub);
  } finally {
    await mock.module("@/api/lib/observability/logger", () => realLoggerModule);
  }

  const failure = warned.find(
    (attributes) => attributes["identityKey"] !== undefined,
  );
  expect(failure?.["error.cause.pg_code"]).toBe("42703");
  // Bounded apart from the outer message: the statement alone would consume
  // the whole budget and leave the cause truncated away.
  expect(failure?.["error.detail"]).toContain('column "reason" does not exist');
});
