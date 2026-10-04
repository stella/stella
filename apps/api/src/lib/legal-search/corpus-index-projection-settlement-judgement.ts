import { panic } from "better-result";

import { Temporal } from "@stll/time";

import type {
  CorpusIndexDeleteSettlement,
  CorpusIndexSettlementSplit,
} from "@/api/lib/legal-search/corpus-index-client";

type LaggingSplits = readonly [
  CorpusIndexSettlementSplit,
  ...CorpusIndexSettlementSplit[],
];

type LaggingPending = {
  settlement: CorpusIndexDeleteSettlement;
  /**
   * The splits the delete has still to reach: the proving ones while any of
   * them lags, otherwise the excluded ones that can hold what the exact count
   * still finds.
   */
  laggingSplits: LaggingSplits;
  /**
   * Null while a proving split lags: the exact count is read only once every
   * proving split has crossed the opstamp.
   */
  remainingRevisionCount: number | null;
};

/**
 * Why a delete task's revisions cannot settle yet. The lag reasons name the
 * lagging split that settles last; the engine catches each of them up on its
 * own. A survivor never settles by waiting.
 */
export type CorpusProjectionCleanupPending =
  /**
   * A lagging split is not published. The engine applies deletes to published
   * splits only; a staged split either publishes or is collected after the
   * engine's grace period.
   */
  | ({ reason: "staged_split" } & LaggingPending)
  /**
   * The lagging splits are published, and at least one has not matured: the
   * engine applies deletes to mature splits only. Nothing settles before
   * `maturesAt`, the latest maturity among them.
   */
  | ({ reason: "immature_split"; maturesAt: Temporal.Instant } & LaggingPending)
  /** The lagging splits are mature: the engine's delete pipeline is behind. */
  | ({ reason: "delete_lagging" } & LaggingPending)
  /**
   * What a survivor looks like, read before the task is older than the
   * index's maturation period. The listing and the count are two reads, and a
   * split published between them is in the count alone; by `confirmableAt`
   * every split that existed when the task was created has matured and been
   * listed, so the verdict cannot rest on a split the listing never showed.
   */
  | {
      reason: "survivor_unconfirmed";
      settlement: CorpusIndexDeleteSettlement;
      remainingRevisionCount: number;
      confirmableAt: Temporal.Instant;
    }
  /**
   * Every split the listing holds has crossed the opstamp, the task is older
   * than the maturation period, and the exact count still finds revision
   * documents. A split at or above the opstamp either had the delete applied
   * or was created after it (a merge output carries the lowest opstamp of its
   * inputs), so what remains was written after the delete, and only a new
   * delete can remove it.
   */
  | {
      reason: "survivor";
      settlement: CorpusIndexDeleteSettlement;
      remainingRevisionCount: number;
    };

export type CorpusProjectionCleanupPendingReason =
  CorpusProjectionCleanupPending["reason"];

export type CorpusProjectionCleanupJudgement =
  /** The proving splits crossed the opstamp; the exact count decides. */
  | { type: "count_required" }
  | { type: "verified" }
  | { type: "pending"; pending: CorpusProjectionCleanupPending };

type JudgeCorpusProjectionCleanupOptions = {
  settlement: CorpusIndexDeleteSettlement;
  /** Exact revision documents the index still holds; null before counting. */
  remainingRevisionCount: number | null;
  /**
   * The reading process's clock, used only to tell an immature split from a
   * mature one; that decides which lag reason is reported, never whether the
   * revisions settle.
   */
  now: Temporal.Instant;
  /** The delete task's creation instant plus the index's maturation period. */
  survivorConfirmableAt: Temporal.Instant;
};

const asLaggingSplits = (
  splits: readonly CorpusIndexSettlementSplit[],
): LaggingSplits | null => {
  const [first, ...rest] = splits;
  return first === undefined ? null : [first, ...rest];
};

/** When the split matures, or null when the engine already applies deletes to it. */
const maturesAfter = (
  { maturity }: CorpusIndexSettlementSplit,
  now: Temporal.Instant,
): Temporal.Instant | null => {
  switch (maturity.type) {
    case "mature":
      return null;
    case "immature":
      return Temporal.Instant.compare(maturity.maturesAt, now) > 0
        ? maturity.maturesAt
        : null;
    default: {
      maturity satisfies never;
      return panic(`Unhandled split maturity ${String(maturity)}`);
    }
  }
};

const laggingPending = (
  laggingSplits: LaggingSplits,
  base: Omit<LaggingPending, "laggingSplits">,
  now: Temporal.Instant,
): CorpusProjectionCleanupPending => {
  if (laggingSplits.some(({ state }) => state === "Staged")) {
    return { reason: "staged_split", ...base, laggingSplits };
  }
  let maturesAt: Temporal.Instant | null = null;
  for (const split of laggingSplits) {
    const splitMaturesAt = maturesAfter(split, now);
    if (
      splitMaturesAt !== null &&
      (maturesAt === null ||
        Temporal.Instant.compare(splitMaturesAt, maturesAt) > 0)
    ) {
      maturesAt = splitMaturesAt;
    }
  }
  return maturesAt === null
    ? { reason: "delete_lagging", ...base, laggingSplits }
    : { reason: "immature_split", ...base, laggingSplits, maturesAt };
};

/**
 * Total over every settlement and count: a delete settles only when no
 * proving split lags and the exact count is zero, and a survivor is declared
 * only when no split the listing holds, proving or excluded, is below the
 * opstamp, and the task is past `survivorConfirmableAt`.
 */
export const judgeCorpusProjectionCleanupSettlement = ({
  settlement,
  remainingRevisionCount,
  now,
  survivorConfirmableAt,
}: JudgeCorpusProjectionCleanupOptions): CorpusProjectionCleanupJudgement => {
  if (
    remainingRevisionCount !== null &&
    (!Number.isSafeInteger(remainingRevisionCount) ||
      remainingRevisionCount < 0)
  ) {
    return panic("Corpus projection remaining revision count is invalid");
  }
  const laggingProving = asLaggingSplits(settlement.laggingProvingSplits);
  if (laggingProving !== null) {
    return {
      type: "pending",
      pending: laggingPending(
        laggingProving,
        { settlement, remainingRevisionCount },
        now,
      ),
    };
  }
  if (remainingRevisionCount === null) {
    return { type: "count_required" };
  }
  if (remainingRevisionCount === 0) {
    return { type: "verified" };
  }
  const laggingExcluded = asLaggingSplits(settlement.laggingExcludedSplits);
  if (laggingExcluded !== null) {
    return {
      type: "pending",
      pending: laggingPending(
        laggingExcluded,
        { settlement, remainingRevisionCount },
        now,
      ),
    };
  }
  if (Temporal.Instant.compare(now, survivorConfirmableAt) < 0) {
    return {
      type: "pending",
      pending: {
        reason: "survivor_unconfirmed",
        settlement,
        remainingRevisionCount,
        confirmableAt: survivorConfirmableAt,
      },
    };
  }
  return {
    type: "pending",
    pending: { reason: "survivor", settlement, remainingRevisionCount },
  };
};
