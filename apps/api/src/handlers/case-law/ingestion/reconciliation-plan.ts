/**
 * Which piece of reconciliation work a source owes next, and when a slice is
 * done being hunted.
 *
 * Kept free of the database and the publisher so the priority order and the
 * settledness rule can be exercised on their own: both are invariants of the
 * loop rather than of any one source, and both are silent when wrong — a
 * mis-ordered priority looks like a slow loop, and a settledness rule that
 * never reaches a fixed point looks like a loop that is always busy.
 */

import { panic } from "better-result";

import { DAY_IN_MS } from "@stll/time";

import type { SourceReconciliation } from "@/api/lib/legal-search/ingestion-types";

/**
 * How long a slice's ledger row stays authoritative. A publisher keeps adding
 * to a slice after first listing it, so a walked slice is a statement about a
 * moment, not a settlement; a day is long enough that the tip window is a
 * fixed, small amount of work and short enough that a late arrival is found
 * while it still matters.
 */
export const RECONCILIATION_SLICE_STALE_MS = DAY_IN_MS;

/** Why a slice was chosen, for the summary and nothing else. */
export const SLICE_WALK_REASON = {
  /** Inside the tip window, where the publisher is still filling in. */
  TIP: "tip",
  /** Held fewer identities than were listed, and the row has gone stale. */
  SHORT: "short",
  /** Never surveyed at all; the sweep works backward through history. */
  SWEEP: "sweep",
} as const;

export type SliceWalkReason =
  (typeof SLICE_WALK_REASON)[keyof typeof SLICE_WALK_REASON];

/**
 * One iteration's work for one source. `idle` is a real answer, not an
 * absence: the source is fully surveyed and nothing is due, and the runner
 * loop backs off on it.
 */
export type ReconciliationWorkUnit =
  | { type: "parked-retries" }
  | { type: "slice"; slice: string; reason: SliceWalkReason }
  | { type: "idle" };

/** A coverage-ledger row as the selection reads it. */
export type LedgerSlice = {
  slice: string;
  /** Distinct keyable identities the publisher listed for the slice. */
  reported: number;
  /** How many of those were held when the slice was last walked. */
  collected: number;
  checkedAt: Date;
};

/** A short ledger row plus the items that slice has retired. */
export type ShortSliceCandidate = LedgerSlice & {
  /** Items retired for this slice; they are accounted for, not missing. */
  terminal: number;
};

/**
 * Whether a slice still owes anything.
 *
 * Without the terminal term this never reaches a fixed point: an item the
 * publisher lists and never serves keeps `collected` below `reported`
 * forever, so the slice is re-selected, re-walked and re-fetched on every
 * pass. Counting retired items as accounted for is what ends the hunt.
 */
export const isSliceSettled = ({
  collected,
  reported,
  terminal,
}: ShortSliceCandidate): boolean => collected + terminal >= reported;

export type ShortSlicePartition = {
  /**
   * Accounted for: held plus retired covers what the publisher listed. These
   * owe no walk, but their ledger rows must still be touched — see
   * `partitionShortSliceCandidates`.
   */
  settled: ShortSliceCandidate[];
  /** Still owed. Only these are selectable work. */
  unsettled: ShortSliceCandidate[];
};

/**
 * Split the short ledger rows into the ones that still owe a walk and the ones
 * that only look like they do.
 *
 * Both halves matter. A settled row stays permanently short — that is what
 * settled means — so it is never re-walked and its `checkedAt` never moves.
 * Left alone it is therefore the oldest-checked row forever, and since the
 * candidate read is a bounded oldest-first window, enough settled rows fill
 * that window completely and every genuinely unsettled slice behind them
 * becomes unreachable. The caller touches the settled half to rotate it out of
 * the window and selects only from the unsettled half.
 *
 * Kept here rather than inside the selection so the settledness rule is
 * applied in exactly one place, by the one caller that can also do something
 * about a settled row.
 */
export const partitionShortSliceCandidates = (
  candidates: readonly ShortSliceCandidate[],
): ShortSlicePartition => {
  const partition: ShortSlicePartition = { settled: [], unsettled: [] };
  for (const candidate of candidates) {
    if (isSliceSettled(candidate)) {
      partition.settled.push(candidate);
    } else {
      partition.unsettled.push(candidate);
    }
  }
  return partition;
};

/**
 * The slices near the tip, newest first.
 *
 * Bounded by `tipWindowDays` and by the adapter's own `previousSlice`, which
 * stops at the first slice the publisher can list, so a source younger than
 * the window yields only the slices that exist.
 */
export const tipWindowSlices = (
  reconciliation: SourceReconciliation,
  now: Date,
): string[] => {
  if (reconciliation.tipWindowDays < 1) {
    panic(
      `tipWindowDays must be at least 1, got ${reconciliation.tipWindowDays}`,
    );
  }
  const slices: string[] = [];
  let cursor: string | null = reconciliation.sliceOf(now);
  while (cursor !== null && slices.length < reconciliation.tipWindowDays) {
    slices.push(cursor);
    cursor = reconciliation.previousSlice(cursor);
  }
  return slices;
};

/**
 * Newest slice first. A plain byte comparison, never a collator: slices are
 * opaque keys whose ordering the ledger relies on, and a locale-aware
 * comparison would make that ordering depend on where the loop runs.
 */
const compareSlicesDescending = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? 1 : -1;
};

export type SelectReconciliationWorkUnitInput = {
  now: Date;
  /** Whether any parked item's next attempt has come due. */
  hasDueParkedItems: boolean;
  /** Tip-window slices, newest first. */
  tipSlices: readonly string[];
  /** When each tip slice was last walked; absent means never. */
  tipCheckedAt: ReadonlyMap<string, Date>;
  /**
   * Stale short ledger rows that still owe a walk, oldest-checked first.
   * Already partitioned by `partitionShortSliceCandidates`: a settled row is
   * not work, and deciding that is the assembly's job because it also has to
   * touch the row.
   */
  unsettledShortSlices: readonly ShortSliceCandidate[];
  /** The newest never-surveyed slice below the tip window, if any remain. */
  sweepSlice: string | null;
  staleAfterMs: number;
};

/**
 * The next work unit, in a fixed priority order:
 *
 *  1. parked retries that have come due — the cheapest work there is, since
 *     the listing payload is already stored and no listing walk is needed;
 *  2. the tip, where the publisher is still adding to slices and a miss is
 *     both most likely and most visible;
 *  3. slices known to be short and gone stale — the ledger's own backlog;
 *  4. history never surveyed at all, newest first.
 *
 * Anything else is idle. The order is deliberately not round-robin between
 * these: history is unbounded and the tip is not, so a sweep that competed
 * with the tip on equal terms would let fresh misses age behind old ones.
 */
export const selectReconciliationWorkUnit = ({
  hasDueParkedItems,
  now,
  staleAfterMs,
  sweepSlice,
  tipCheckedAt,
  tipSlices,
  unsettledShortSlices,
}: SelectReconciliationWorkUnitInput): ReconciliationWorkUnit => {
  if (hasDueParkedItems) {
    return { type: "parked-retries" };
  }

  const staleBefore = now.getTime() - staleAfterMs;
  const dueTipSlices = tipSlices.filter((slice) => {
    const checkedAt = tipCheckedAt.get(slice);
    return checkedAt === undefined || checkedAt.getTime() < staleBefore;
  });
  // Never walked sorts before anything walked, and among equals the newer
  // slice wins: the tip is where the publisher is still writing.
  const oldestTipSlice = dueTipSlices
    .map((slice) => ({
      slice,
      checkedAtMs:
        tipCheckedAt.get(slice)?.getTime() ?? Number.NEGATIVE_INFINITY,
    }))
    .sort(
      (left, right) =>
        left.checkedAtMs - right.checkedAtMs ||
        compareSlicesDescending(left.slice, right.slice),
    )
    .at(0);
  if (oldestTipSlice !== undefined) {
    return {
      type: "slice",
      slice: oldestTipSlice.slice,
      reason: SLICE_WALK_REASON.TIP,
    };
  }

  // Already partitioned by the assembly, which had to look at settledness
  // anyway to know which rows to touch; re-deciding it here would be a second
  // copy of the rule free to drift from that one.
  const owed = unsettledShortSlices.at(0);
  if (owed !== undefined) {
    return {
      type: "slice",
      slice: owed.slice,
      reason: SLICE_WALK_REASON.SHORT,
    };
  }

  if (sweepSlice !== null) {
    return {
      type: "slice",
      slice: sweepSlice,
      reason: SLICE_WALK_REASON.SWEEP,
    };
  }

  return { type: "idle" };
};
