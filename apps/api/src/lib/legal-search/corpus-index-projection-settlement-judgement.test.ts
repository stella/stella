import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import type {
  CorpusIndexDeleteSettlement,
  CorpusIndexSettlementSplit,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  type CorpusProjectionCleanupJudgement,
  type CorpusProjectionCleanupPendingReason,
  judgeCorpusProjectionCleanupSettlement,
} from "@/api/lib/legal-search/corpus-index-projection-settlement-judgement";

const REQUIRED_OPSTAMP = 42;
const NOW = Temporal.Instant.from("2026-10-01T12:00:00Z");
const CONFIRMABLE_AT = Temporal.Instant.from("2026-10-01T10:00:00Z");
const instantAt = (offsetSeconds: number) =>
  Temporal.Instant.fromEpochMilliseconds(
    NOW.epochMilliseconds + offsetSeconds * 1000,
  );

const split = (
  overrides: Partial<CorpusIndexSettlementSplit> = {},
): CorpusIndexSettlementSplit => ({
  splitId: "split-a",
  state: "Published",
  appliedOpstamp: REQUIRED_OPSTAMP - 1,
  publishedAt: instantAt(-3600),
  maturity: { type: "mature" },
  ...overrides,
});

const settlementOf = ({
  laggingProvingSplits = [],
  laggingExcludedSplits = [],
}: {
  laggingProvingSplits?: CorpusIndexSettlementSplit[];
  laggingExcludedSplits?: CorpusIndexSettlementSplit[];
}): CorpusIndexDeleteSettlement => ({
  requiredOpstamp: REQUIRED_OPSTAMP,
  provingSplits: laggingProvingSplits.length + 1,
  excludedSplits: laggingExcludedSplits.length,
  laggingSplits: laggingProvingSplits.length,
  minAppliedOpstamp: Math.min(
    REQUIRED_OPSTAMP,
    ...laggingProvingSplits.map(({ appliedOpstamp }) => appliedOpstamp),
  ),
  settled: laggingProvingSplits.length === 0,
  laggingProvingSplits,
  laggingExcludedSplits,
});

const judge = (
  settlement: CorpusIndexDeleteSettlement,
  remainingRevisionCount: number | null,
  now = NOW,
) =>
  judgeCorpusProjectionCleanupSettlement({
    settlement,
    remainingRevisionCount,
    now,
    survivorConfirmableAt: CONFIRMABLE_AT,
  });

const reasonOf = (
  judgement: CorpusProjectionCleanupJudgement,
):
  | CorpusProjectionCleanupPendingReason
  | CorpusProjectionCleanupJudgement["type"] =>
  judgement.type === "pending" ? judgement.pending.reason : judgement.type;

test("a lagging proving split holds the verdict before anything is counted", () => {
  const lagging = settlementOf({ laggingProvingSplits: [split()] });

  expect(reasonOf(judge(lagging, null))).toBe("delete_lagging");
  // A count read anyway cannot overrule the listing.
  expect(reasonOf(judge(lagging, 0))).toBe("delete_lagging");
  expect(reasonOf(judge(settlementOf({}), null))).toBe("count_required");
  expect(reasonOf(judge(settlementOf({}), 0))).toBe("verified");
});

test("the lag reason names the split class that settles last", () => {
  const staged = split({
    splitId: "split-staged",
    state: "Staged",
    publishedAt: null,
  });
  const immature = split({
    splitId: "split-immature",
    maturity: { type: "immature", maturesAt: instantAt(600) },
  });
  const laterImmature = split({
    splitId: "split-immature-later",
    maturity: { type: "immature", maturesAt: instantAt(1200) },
  });
  const maturedAlready = split({
    splitId: "split-matured",
    maturity: { type: "immature", maturesAt: instantAt(-1) },
  });
  const mature = split({ splitId: "split-mature" });

  expect(
    reasonOf(
      judge(
        settlementOf({ laggingProvingSplits: [mature, immature, staged] }),
        null,
      ),
    ),
  ).toBe("staged_split");
  const immatureVerdict = judge(
    settlementOf({
      laggingProvingSplits: [mature, laterImmature, immature],
    }),
    null,
  );
  if (
    immatureVerdict.type !== "pending" ||
    immatureVerdict.pending.reason !== "immature_split"
  ) {
    throw new Error(
      `expected immature_split, got ${reasonOf(immatureVerdict)}`,
    );
  }
  expect(immatureVerdict.pending.maturesAt).toEqual(instantAt(1200));
  expect(
    immatureVerdict.pending.laggingSplits.map(({ splitId }) => splitId),
  ).toEqual(["split-mature", "split-immature-later", "split-immature"]);
  // Past its maturity instant an immature split is lag like any mature one.
  expect(
    reasonOf(
      judge(
        settlementOf({ laggingProvingSplits: [maturedAlready, mature] }),
        null,
      ),
    ),
  ).toBe("delete_lagging");
});

test("documents a lagging excluded split can hold are not survivors", () => {
  // A merge output published after the task inherits its inputs' opstamp:
  // outside the proof, below the task, and able to hold what the count finds.
  const mergedAfterTask = split({
    splitId: "split-merged",
    appliedOpstamp: REQUIRED_OPSTAMP - 5,
    publishedAt: instantAt(-60),
    maturity: { type: "immature", maturesAt: instantAt(14_400) },
  });
  const settlement = settlementOf({ laggingExcludedSplits: [mergedAfterTask] });

  expect(reasonOf(judge(settlement, null))).toBe("count_required");
  // Zero is exact: nothing of the revisions is left wherever it was.
  expect(reasonOf(judge(settlement, 0))).toBe("verified");
  const counted = judge(settlement, 27);
  if (
    counted.type !== "pending" ||
    counted.pending.reason !== "immature_split"
  ) {
    throw new Error(`expected immature_split, got ${reasonOf(counted)}`);
  }
  expect(counted.pending.remainingRevisionCount).toBe(27);
  expect(counted.pending.maturesAt).toEqual(instantAt(14_400));
});

test("a survivor stands only past the confirmation instant", () => {
  const settlement = settlementOf({});

  const early = judge(settlement, 3, CONFIRMABLE_AT.subtract({ seconds: 1 }));
  if (
    early.type !== "pending" ||
    early.pending.reason !== "survivor_unconfirmed"
  ) {
    throw new Error(`expected survivor_unconfirmed, got ${reasonOf(early)}`);
  }
  expect(early.pending.confirmableAt).toEqual(CONFIRMABLE_AT);
  expect(reasonOf(judge(settlement, 3, CONFIRMABLE_AT))).toBe("survivor");
});

const STATES = ["Published", "Staged"] as const;

const splitArb: fc.Arbitrary<CorpusIndexSettlementSplit> = fc.record({
  splitId: fc.constantFrom("split-a", "split-b", "split-c"),
  state: fc.constantFrom(...STATES),
  appliedOpstamp: fc.integer({ min: 0, max: REQUIRED_OPSTAMP - 1 }),
  publishedAt: fc.option(fc.integer({ min: -7200, max: 7200 }).map(instantAt), {
    nil: null,
  }),
  maturity: fc.oneof(
    fc.constant({ type: "mature" as const }),
    fc.integer({ min: -7200, max: 7200 }).map((offset) => ({
      type: "immature" as const,
      maturesAt: instantAt(offset),
    })),
  ),
});

const judgementInputArb = fc.record({
  laggingProvingSplits: fc.array(splitArb, { maxLength: 3 }),
  laggingExcludedSplits: fc.array(splitArb, { maxLength: 3 }),
  remainingRevisionCount: fc.option(fc.nat({ max: 5 }), { nil: null }),
  nowOffset: fc.integer({ min: -7200, max: 7200 }),
});

const isImmatureAt = (
  { maturity }: CorpusIndexSettlementSplit,
  now: Temporal.Instant,
) =>
  maturity.type === "immature" &&
  Temporal.Instant.compare(maturity.maturesAt, now) > 0;

test("settlement judgement is total and settles or re-deletes only on complete evidence", () => {
  assertProperty(
    "settlement judgement is total and settles or re-deletes only on complete evidence",
    fc.property(
      judgementInputArb,
      ({
        laggingProvingSplits,
        laggingExcludedSplits,
        remainingRevisionCount,
        nowOffset,
      }) => {
        const now = instantAt(nowOffset);
        const judgement = judgeCorpusProjectionCleanupSettlement({
          settlement: settlementOf({
            laggingProvingSplits,
            laggingExcludedSplits,
          }),
          remainingRevisionCount,
          now,
          survivorConfirmableAt: NOW,
        });
        const proofLags = laggingProvingSplits.length > 0;
        switch (judgement.type) {
          case "count_required":
            expect(proofLags).toBe(false);
            expect(remainingRevisionCount).toBeNull();
            return;
          case "verified":
            expect(proofLags).toBe(false);
            expect(remainingRevisionCount).toBe(0);
            return;
          case "pending":
            break;
          default: {
            judgement satisfies never;
            throw new Error(`unhandled judgement ${String(judgement)}`);
          }
        }
        const { pending } = judgement;
        switch (pending.reason) {
          case "survivor":
          case "survivor_unconfirmed":
            // Nothing the listing holds is below the opstamp, and something
            // of the revisions is still there.
            expect(laggingProvingSplits).toEqual([]);
            expect(laggingExcludedSplits).toEqual([]);
            expect(pending.remainingRevisionCount).toBeGreaterThan(0);
            expect(Temporal.Instant.compare(now, NOW) >= 0).toBe(
              pending.reason === "survivor",
            );
            return;
          case "staged_split":
          case "immature_split":
          case "delete_lagging": {
            // The proving splits while any lags; otherwise the excluded ones,
            // and only once a count found something they can hold.
            expect([...pending.laggingSplits]).toEqual(
              proofLags ? laggingProvingSplits : laggingExcludedSplits,
            );
            if (!proofLags) {
              expect(remainingRevisionCount).toBeGreaterThan(0);
            }
            const staged = pending.laggingSplits.some(
              ({ state }) => state === "Staged",
            );
            const immature = pending.laggingSplits.filter((lagging) =>
              isImmatureAt(lagging, now),
            );
            expect(pending.reason === "staged_split").toBe(staged);
            expect(pending.reason === "immature_split").toBe(
              !staged && immature.length > 0,
            );
            if (pending.reason === "immature_split") {
              const latest = immature
                .map(({ maturity }) =>
                  maturity.type === "immature" ? maturity.maturesAt : now,
                )
                .toSorted(Temporal.Instant.compare)
                .at(-1);
              expect(pending.maturesAt).toEqual(latest ?? now);
            }
            return;
          }
          default: {
            pending satisfies never;
            throw new Error(`unhandled pending ${String(pending)}`);
          }
        }
      },
    ),
  );
});
