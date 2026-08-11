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

import { czRegionalAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import type {
  ShortSliceCandidate,
  SelectReconciliationWorkUnitInput,
} from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import {
  RECONCILIATION_SLICE_STALE_MS,
  SLICE_WALK_REASON,
  isSliceSettled,
  partitionShortSliceCandidates,
  selectReconciliationWorkUnit,
  tipWindowSlices,
} from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import { toUtcDateString } from "@/api/lib/dates";
import type { SourceReconciliation } from "@/api/lib/legal-search/ingestion-types";
import {
  listingIdentityKey,
  parseListingIdentityKey,
} from "@/api/lib/legal-search/ingestion-types";

const NOW = new Date("2026-08-11T09:30:00.000Z");
const FRESH = new Date("2026-08-11T06:00:00.000Z");
const STALE = new Date("2026-08-08T06:00:00.000Z");

const reconciliation = ((): SourceReconciliation => {
  const capability = czRegionalAdapter.reconciliation;
  if (capability === undefined) {
    throw new Error("cz-regional must declare the reconciliation capability");
  }
  return capability;
})();

const baseInput = (
  overrides: Partial<SelectReconciliationWorkUnitInput> = {},
): SelectReconciliationWorkUnitInput => ({
  now: NOW,
  hasDueParkedItems: false,
  tipSlices: [],
  tipCheckedAt: new Map(),
  unsettledShortSlices: [],
  sweepSlice: null,
  staleAfterMs: RECONCILIATION_SLICE_STALE_MS,
  ...overrides,
});

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
