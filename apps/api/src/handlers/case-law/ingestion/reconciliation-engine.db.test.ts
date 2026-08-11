import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCoverageSlices,
  caseLawReconciliationItems,
  caseLawSources,
  RECONCILIATION_ITEM_STATUS,
  relations,
} from "@/api/db/schema";
import { runReconciliationWorkUnit } from "@/api/handlers/case-law/ingestion/reconciliation-engine";
import { SLICE_WALK_REASON } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { addUtcDays, toUtcDateString } from "@/api/lib/dates";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";
import type {
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

/**
 * A publisher that lists two decisions and serves neither document. Enough to
 * drive a real walk without a pipeline write: what is under test is which
 * slice the engine chose, not what it stored.
 */
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
      totalPages: 1,
    });
  },
  buildDecision: async () =>
    await Promise.resolve({ type: "detail-unavailable" }),
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

const runUnit = async (sourceId: SafeId<"caseLawSource">) =>
  await runReconciliationWorkUnit({
    adapterKey: "engine-fixture",
    sourceId,
    reconciliation: stubReconciliation,
    scopedDb,
    now: () => NOW,
    fetchDelayMs: 0,
    sleep: async () => {
      await Promise.resolve();
    },
  });

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
