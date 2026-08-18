/**
 * The two invariants the reconciliation loop has no other way to state.
 *
 * The priority order is silent when wrong: a mis-ordered selection still does
 * work every turn, it just does the wrong work, and a fresh miss ages behind
 * a decade of history without anything failing. The settledness rule is worse
 * — a slice that can never settle is re-walked and re-fetched forever, which
 * looks exactly like a healthy busy loop.
 *
 * Slices here are the real thing: UTC days as the publisher's opendata
 * endpoint is addressed by, and identity keys carrying real finaldoc UUIDs. A
 * shortened stand-in would never exercise the lexicographic ordering the
 * ledger depends on.
 */

import { describe, expect, test } from "bun:test";

import { DAY_IN_MS } from "@stll/time";

import { czRegionalAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import type {
  FailedSliceCandidate,
  LedgerSlice,
  ShortSliceCandidate,
  SelectReconciliationWorkUnitInput,
  SliceWalkReason,
} from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import {
  RECONCILIATION_FAILED_SLICE_RETRY_MS,
  RECONCILIATION_SETTLED_RECHECK_MS,
  RECONCILIATION_SLICE_STALE_MS,
  SLICE_WALK_REASON,
  isSliceSettled,
  partitionShortSliceCandidates,
  selectReconciliationWorkUnit,
  tipWindowSlices,
} from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import { toUtcDateString } from "@/api/lib/dates";
import {
  listingIdentityKey,
  parseListingIdentityKey,
} from "@/api/lib/legal-search/ingestion-types";

const NOW = new Date("2026-08-11T09:30:00.000Z");
const FRESH = new Date("2026-08-11T06:00:00.000Z");
const STALE = new Date("2026-08-08T06:00:00.000Z");

const reconciliation = requireReconciliation(czRegionalAdapter);

const baseInput = (
  overrides: Partial<SelectReconciliationWorkUnitInput> = {},
): SelectReconciliationWorkUnitInput => ({
  now: NOW,
  hasDueParkedItems: false,
  tipSlices: [],
  tipCheckedAt: new Map(),
  unsettledShortSlices: [],
  failedCandidate: null,
  sweepSlice: null,
  recheckCandidate: null,
  slicesHeldForRetry: new Set(),
  staleAfterMs: RECONCILIATION_SLICE_STALE_MS,
  recheckAfterMs: RECONCILIATION_SETTLED_RECHECK_MS,
  failedRetryAfterMs: RECONCILIATION_FAILED_SLICE_RETRY_MS,
  ...overrides,
});

/** A ledger row whose last walk failed at `checkedAt`. */
const failedCandidate = (checkedAt: Date): FailedSliceCandidate => ({
  slice: "2024-02-02",
  checkedAt,
});

const RESTED = new Date(
  NOW.getTime() - RECONCILIATION_FAILED_SLICE_RETRY_MS - 60_000,
);

/** A settled ledger row, checked long enough ago to be worth proving again. */
const recheckCandidate = (checkedAt: Date): LedgerSlice => ({
  slice: "2024-01-01",
  reported: 12,
  collected: 12,
  checkedAt,
});

const LONG_SETTLED = new Date(
  NOW.getTime() - RECONCILIATION_SETTLED_RECHECK_MS - DAY_IN_MS,
);

const shortSlice = (
  overrides: Partial<ShortSliceCandidate> = {},
): ShortSliceCandidate => ({
  slice: "2024-03-12",
  reported: 40,
  collected: 30,
  checkedAt: STALE,
  terminal: 0,
  ...overrides,
});

describe("tipWindowSlices", () => {
  test("the window is the tip and the days before it, newest first", () => {
    // Lexicographic order is chronological order for these slices, which is
    // what lets the ledger be read and compared without parsing a slice.
    const slices = tipWindowSlices(reconciliation, NOW);

    expect(slices).toHaveLength(reconciliation.tipWindowDays);
    expect(slices.at(0)).toBe("2026-08-11");
    expect(slices.at(-1)).toBe("2026-07-29");
    expect(slices.toSorted().toReversed()).toEqual(slices);
  });

  test("the window stops at the first slice the publisher can list", () => {
    const atFeedStart = new Date(`${reconciliation.firstSlice}T12:00:00.000Z`);
    expect(tipWindowSlices(reconciliation, atFeedStart)).toEqual([
      reconciliation.firstSlice,
    ]);
  });

  test("the walk steps one day at a time in both directions", () => {
    const slice = "2026-03-01";
    // Across a month boundary and a European DST change, where a fixed 24h
    // step in local time would land on the wrong calendar day.
    expect(reconciliation.previousSlice(slice)).toBe("2026-02-28");
    expect(reconciliation.nextSlice("2026-03-28")).toBe("2026-03-29");
    expect(reconciliation.previousSlice(reconciliation.firstSlice)).toBeNull();
    expect(reconciliation.nextSlice(toUtcDateString(new Date()))).toBeNull();
  });
});

describe("partitionShortSliceCandidates", () => {
  test("a slice whose shortfall is entirely terminal is accounted for", () => {
    // The fixed point. Without the terminal term this slice is short
    // forever, so it is selected, walked and re-fetched on every pass, and
    // the loop can never reach anything below it.
    const settled = shortSlice({ reported: 40, collected: 30, terminal: 10 });
    expect(isSliceSettled(settled)).toBe(true);
    // …and it stays settled once more items retire than are outstanding.
    expect(isSliceSettled({ ...settled, terminal: 11 })).toBe(true);

    expect(partitionShortSliceCandidates([settled])).toEqual({
      settled: [settled],
      unsettled: [],
    });
  });

  test("a slice still owing decisions stays selectable", () => {
    const owed = shortSlice({ reported: 12, collected: 9, terminal: 1 });
    expect(partitionShortSliceCandidates([owed])).toEqual({
      settled: [],
      unsettled: [owed],
    });
  });

  test("both halves are returned, and together they are the whole window", () => {
    // The settled half is not discarded: its rows have to be touched, or
    // they stay the oldest-checked forever and the bounded candidate window
    // fills with slices that owe nothing, starving the ones that do.
    const settled = shortSlice({
      slice: "2024-03-12",
      reported: 40,
      collected: 30,
      terminal: 10,
    });
    const owed = shortSlice({
      slice: "2024-05-02",
      reported: 12,
      collected: 9,
      terminal: 1,
    });

    const partition = partitionShortSliceCandidates([settled, owed]);
    expect(partition).toEqual({ settled: [settled], unsettled: [owed] });
    expect([...partition.settled, ...partition.unsettled]).toHaveLength(2);
  });

  test("order within each half is the order it arrived in", () => {
    // The candidate read is oldest-checked first and selection takes the
    // head, so a partition that reordered would silently change which slice
    // is walked.
    const older = shortSlice({ slice: "2024-01-02", checkedAt: STALE });
    const newer = shortSlice({
      slice: "2024-09-30",
      checkedAt: new Date("2026-08-09T06:00:00.000Z"),
    });

    expect(
      partitionShortSliceCandidates([older, newer]).unsettled.map(
        ({ slice }) => slice,
      ),
    ).toEqual(["2024-01-02", "2024-09-30"]);
  });
});

describe("selectReconciliationWorkUnit", () => {
  test("due parked items outrank every slice walk", () => {
    // The cheapest work there is: the payload is already stored, so no
    // listing walk is needed to act on it.
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          hasDueParkedItems: true,
          tipSlices: ["2026-08-11"],
          unsettledShortSlices: [shortSlice()],
          sweepSlice: "2024-01-01",
        }),
      ),
    ).toEqual({ type: "parked-retries" });
  });

  test("a never-walked tip slice outranks a short slice and the sweep", () => {
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          tipSlices: ["2026-08-11", "2026-08-10"],
          tipCheckedAt: new Map([["2026-08-11", FRESH]]),
          unsettledShortSlices: [shortSlice()],
          sweepSlice: "2024-01-01",
        }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2026-08-10",
      reason: SLICE_WALK_REASON.TIP,
    });
  });

  test("among stale tip slices the oldest-checked one is walked", () => {
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          tipSlices: ["2026-08-11", "2026-08-10", "2026-08-09"],
          tipCheckedAt: new Map([
            ["2026-08-11", new Date("2026-08-09T00:00:00.000Z")],
            ["2026-08-10", new Date("2026-08-08T00:00:00.000Z")],
            ["2026-08-09", FRESH],
          ]),
        }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2026-08-10",
      reason: SLICE_WALK_REASON.TIP,
    });
  });

  test("a tip slice checked within the staleness window is left alone", () => {
    // Otherwise the tip is re-walked every turn and the loop never reaches
    // anything else.
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          tipSlices: ["2026-08-11", "2026-08-10"],
          tipCheckedAt: new Map([
            ["2026-08-11", FRESH],
            ["2026-08-10", FRESH],
          ]),
          unsettledShortSlices: [shortSlice()],
        }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2024-03-12",
      reason: SLICE_WALK_REASON.SHORT,
    });
  });

  test("the oldest owed short slice is taken, in the order it was handed over", () => {
    const first = shortSlice({ slice: "2024-03-12", checkedAt: STALE });
    const second = shortSlice({ slice: "2024-05-02" });

    expect(
      selectReconciliationWorkUnit(
        baseInput({ unsettledShortSlices: [first, second] }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2024-03-12",
      reason: SLICE_WALK_REASON.SHORT,
    });
  });

  test("no owed short slice falls through to the sweep", () => {
    expect(
      selectReconciliationWorkUnit(
        baseInput({ unsettledShortSlices: [], sweepSlice: "2024-01-01" }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2024-01-01",
      reason: SLICE_WALK_REASON.SWEEP,
    });
  });

  test("history is swept only once nothing nearer is owed", () => {
    expect(
      selectReconciliationWorkUnit(baseInput({ sweepSlice: "2024-01-01" })),
    ).toEqual({
      type: "slice",
      slice: "2024-01-01",
      reason: SLICE_WALK_REASON.SWEEP,
    });
  });

  test("a fully surveyed, settled source reports idle", () => {
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          tipSlices: ["2026-08-11"],
          tipCheckedAt: new Map([["2026-08-11", FRESH]]),
          unsettledShortSlices: [],
        }),
      ),
    ).toEqual({ type: "idle" });
  });

  test("an otherwise idle source spends the turn re-proving a settled slice", () => {
    // The only unit that walks a slice nothing is known to owe. Idle turns
    // become slow verification, which is the whole of the argument for it: a
    // slice that settled early keeps stating what the publisher listed that
    // day, and publishers go on adding to slices for months afterwards.
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          tipSlices: ["2026-08-11"],
          tipCheckedAt: new Map([["2026-08-11", FRESH]]),
          recheckCandidate: recheckCandidate(LONG_SETTLED),
        }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2024-01-01",
      reason: SLICE_WALK_REASON.RECHECK,
    });
  });

  test("a settled slice inside the recheck window is left alone", () => {
    // The candidate is always read; the window is what decides. Without it the
    // loop re-walks proved history at the idle cadence, spending on slices it
    // has already accounted for the politeness budget that short slices need.
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          recheckCandidate: recheckCandidate(
            new Date(
              NOW.getTime() - RECONCILIATION_SETTLED_RECHECK_MS + DAY_IN_MS,
            ),
          ),
        }),
      ),
    ).toEqual({ type: "idle" });
  });

  test("every nearer priority outranks the recheck, one at a time", () => {
    // Stated as one case per competing priority rather than all four at once:
    // a chain that fell through on three of them and was saved by the fourth
    // would pass a combined assertion unchanged.
    const nearer = [
      { hasDueParkedItems: true },
      { tipSlices: ["2026-08-11"], tipCheckedAt: new Map<string, Date>() },
      { unsettledShortSlices: [shortSlice()] },
      { failedCandidate: failedCandidate(RESTED) },
      { sweepSlice: "2023-06-01" },
    ] as const satisfies readonly Partial<SelectReconciliationWorkUnitInput>[];

    for (const [index, overrides] of nearer.entries()) {
      const unit = selectReconciliationWorkUnit(
        baseInput({
          ...overrides,
          recheckCandidate: recheckCandidate(LONG_SETTLED),
        }),
      );
      const rechecked =
        unit.type === "slice" && unit.reason === SLICE_WALK_REASON.RECHECK;
      expect({ index, rechecked }).toEqual({ index, rechecked: false });
    }
  });

  test("every walk reason is reachable, and each input reaches only its own", () => {
    // Total over the union, so a reason cannot be added without an input that
    // produces it; the loop asserts the other direction, that each input
    // reaches exactly the reason it is filed under.
    const inputByReason = {
      [SLICE_WALK_REASON.TIP]: baseInput({ tipSlices: ["2026-08-11"] }),
      [SLICE_WALK_REASON.SHORT]: baseInput({
        unsettledShortSlices: [shortSlice()],
      }),
      [SLICE_WALK_REASON.RETRY]: baseInput({
        failedCandidate: failedCandidate(RESTED),
      }),
      [SLICE_WALK_REASON.SWEEP]: baseInput({ sweepSlice: "2023-06-01" }),
      [SLICE_WALK_REASON.RECHECK]: baseInput({
        recheckCandidate: recheckCandidate(LONG_SETTLED),
      }),
    } as const satisfies Record<
      SliceWalkReason,
      SelectReconciliationWorkUnitInput
    >;

    for (const [reason, input] of Object.entries(inputByReason)) {
      expect(selectReconciliationWorkUnit(input)).toMatchObject({
        type: "slice",
        reason,
      });
    }
  });
});

describe("a slice whose last walk failed", () => {
  // The failure is recorded in the ledger, so the sweep and the backlog move
  // on around it; what remains to decide is when it is tried again, and that
  // it is tried ahead of new history but never ahead of work something owes.
  test("is walked again once it has rested, ahead of the sweep", () => {
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          failedCandidate: failedCandidate(RESTED),
          sweepSlice: "2023-06-01",
        }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2024-02-02",
      reason: SLICE_WALK_REASON.RETRY,
    });
  });

  test("still resting, it yields to the sweep", () => {
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          failedCandidate: failedCandidate(
            new Date(
              NOW.getTime() - RECONCILIATION_FAILED_SLICE_RETRY_MS + 60_000,
            ),
          ),
          sweepSlice: "2023-06-01",
        }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2023-06-01",
      reason: SLICE_WALK_REASON.SWEEP,
    });
  });

  test("held in this process, it yields even when rested", () => {
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          failedCandidate: failedCandidate(RESTED),
          slicesHeldForRetry: new Set(["2024-02-02"]),
        }),
      ),
    ).toEqual({ type: "idle" });
  });
});

describe("a slice held for retry", () => {
  // A failed walk writes nothing, so every input this selection reads is
  // unchanged by it. Without the hold the same slice comes back on the next
  // turn and on every turn after it, and the source's other work — its tip,
  // its backlog, its sweep — is never reached again. These assert the source
  // keeps moving at each priority the hold can apply to.
  const held = (slice: string) => ({ slicesHeldForRetry: new Set([slice]) });

  test("a held tip slice yields to the rest of the tip window", () => {
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          tipSlices: ["2026-08-11", "2026-08-10"],
          ...held("2026-08-11"),
        }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2026-08-10",
      reason: SLICE_WALK_REASON.TIP,
    });
  });

  test("a tip window held end to end falls through to the backlog", () => {
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          tipSlices: ["2026-08-11"],
          unsettledShortSlices: [shortSlice({ slice: "2024-03-12" })],
          sweepSlice: "2024-01-01",
          ...held("2026-08-11"),
        }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2024-03-12",
      reason: SLICE_WALK_REASON.SHORT,
    });
  });

  test("a held backlog slice yields to the next one owed", () => {
    // The backlog is read oldest-checked first and selection took the head,
    // so one unwalkable row at the front stopped the whole queue.
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          unsettledShortSlices: [
            shortSlice({ slice: "2024-03-12" }),
            shortSlice({ slice: "2024-05-02" }),
          ],
          ...held("2024-03-12"),
        }),
      ),
    ).toEqual({
      type: "slice",
      slice: "2024-05-02",
      reason: SLICE_WALK_REASON.SHORT,
    });
  });

  test("a held sweep slice does not block the recheck behind it", () => {
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          sweepSlice: "2023-06-01",
          recheckCandidate: recheckCandidate(LONG_SETTLED),
          ...held("2023-06-01"),
        }),
      ),
    ).toMatchObject({ reason: SLICE_WALK_REASON.RECHECK });
  });

  test("a source whose every candidate is held reports idle, not the slice", () => {
    // Idle is the honest answer: the loop's own pacing then backs the source
    // off, where returning the slice again would spin it at the unit rate.
    const recheck = recheckCandidate(LONG_SETTLED);
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          tipSlices: ["2026-08-11"],
          unsettledShortSlices: [shortSlice({ slice: "2024-03-12" })],
          sweepSlice: "2024-01-01",
          recheckCandidate: recheck,
          slicesHeldForRetry: new Set([
            "2026-08-11",
            "2024-03-12",
            "2024-01-01",
            recheck.slice,
          ]),
        }),
      ),
    ).toEqual({ type: "idle" });
  });

  test("holding a slice never displaces work that outranks it", () => {
    // The hold subtracts candidates; it must not reorder what is left.
    expect(
      selectReconciliationWorkUnit(
        baseInput({
          hasDueParkedItems: true,
          tipSlices: ["2026-08-11"],
          ...held("2026-08-11"),
        }),
      ),
    ).toEqual({ type: "parked-retries" });
  });
});

describe("RECONCILIATION_SETTLED_RECHECK_MS", () => {
  test("a recheck is an order of magnitude rarer than the tip cadence", () => {
    // The two constants describe opposite ends of the same ledger. If the
    // recheck window ever approached the staleness window, every settled slice
    // in a source's history would come due about as often as the tip does, and
    // the loop would spend its life re-walking history it had already proved.
    expect(RECONCILIATION_SETTLED_RECHECK_MS).toBeGreaterThan(
      RECONCILIATION_SLICE_STALE_MS * 10,
    );
  });
});

describe("listing identity keys", () => {
  test("every keyable identity round-trips through its stored key", () => {
    // The key is written to a column and read back days later to ask whether
    // the decision has since been stored. A parser that drifted from the
    // formatter would answer that question about the wrong decision.
    const identities = [
      {
        type: "document",
        sourceDocumentId: "2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23",
      },
      { type: "case-number", caseNumber: "11 C 153/2025", language: "cs" },
      // A docket carrying the separator the key format uses.
      { type: "case-number", caseNumber: "II. ÚS 1234:56/24", language: "cs" },
    ] as const;

    for (const identity of identities) {
      const key = listingIdentityKey(identity);
      expect(key).not.toBeNull();
      expect(parseListingIdentityKey(key ?? "")).toEqual(identity);
    }
  });

  test("an identity with nothing to key on has no key", () => {
    expect(listingIdentityKey({ type: "unidentifiable" })).toBeNull();
  });

  test("a key too long for the column is refused rather than truncated", () => {
    // A truncated key would collide with another decision's, and the park it
    // wrote would then resolve on the wrong document being stored.
    expect(
      listingIdentityKey({
        type: "document",
        sourceDocumentId: "x".repeat(400),
      }),
    ).toBeNull();
  });

  test("an identity with an empty component has no key at all", () => {
    // Formatting one would produce a key this module's own parser rejects,
    // so the row would be written and then read back as unreadable. The
    // formatter refuses instead, and the caller treats it exactly like an
    // identity there was never anything to key on.
    const empties = [
      { type: "document", sourceDocumentId: "" },
      { type: "case-number", caseNumber: "", language: "cs" },
      { type: "case-number", caseNumber: "11 C 153/2025", language: "" },
    ] as const;

    for (const identity of empties) {
      expect({ identity, key: listingIdentityKey(identity) }).toEqual({
        identity,
        key: null,
      });
    }
  });

  test("a formatted key always reads back; the two never disagree", () => {
    // The invariant that binds the pair: whenever a key exists, parsing it
    // returns something. Any identity the formatter accepts but the parser
    // rejects would be stored and then silently unreadable.
    const identities = [
      { type: "document", sourceDocumentId: "2f0a1d6c-9c7f" },
      { type: "case-number", caseNumber: "11 C 153/2025", language: "cs" },
      { type: "document", sourceDocumentId: "" },
      { type: "case-number", caseNumber: "", language: "cs" },
      { type: "case-number", caseNumber: "x", language: "" },
      { type: "unidentifiable" },
      { type: "document", sourceDocumentId: "y".repeat(400) },
    ] as const;

    for (const identity of identities) {
      const key = listingIdentityKey(identity);
      const readable = key === null || parseListingIdentityKey(key) !== null;
      expect({ identity, readable }).toEqual({ identity, readable: true });
    }
  });

  test("a key no current rule produces reads as nothing", () => {
    for (const key of ["", "document:", "case-number:", "case-number:cs:"]) {
      expect(parseListingIdentityKey(key)).toBeNull();
    }
  });
});
