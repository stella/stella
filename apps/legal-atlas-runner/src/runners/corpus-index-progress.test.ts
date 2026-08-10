import { describe, expect, test } from "bun:test";

import {
  CORPUS_INDEX_STALL_THRESHOLD,
  CORPUS_INDEX_STEP,
  type CorpusIndexStepKind,
  type CorpusIndexStreaks,
  INITIAL_CORPUS_INDEX_STREAKS,
  stepCorpusIndexProgress,
} from "./corpus-index-progress";

/** Fold a whole step sequence, collecting every reported stall. */
const foldSequence = (kinds: readonly CorpusIndexStepKind[]) => {
  let streaks: CorpusIndexStreaks = INITIAL_CORPUS_INDEX_STREAKS;
  const stalls: NonNullable<
    ReturnType<typeof stepCorpusIndexProgress>["stall"]
  >[] = [];
  for (const kind of kinds) {
    const step = stepCorpusIndexProgress(streaks, kind);
    streaks = step.streaks;
    if (step.stall) {
      stalls.push(step.stall);
    }
  }
  return { stalls, streaks };
};

const repeat = (kind: CorpusIndexStepKind, count: number) =>
  Array.from({ length: count }, () => kind);

describe("stepCorpusIndexProgress", () => {
  test("a streak one short of the threshold reports nothing", () => {
    for (const kind of [CORPUS_INDEX_STEP.BUSY, CORPUS_INDEX_STEP.FAILED]) {
      const { stalls } = foldSequence(
        repeat(kind, CORPUS_INDEX_STALL_THRESHOLD - 1),
      );
      expect(stalls).toEqual([]);
    }
  });

  test("a sustained condition reports once per threshold-run, not per step", () => {
    const { stalls } = foldSequence(
      repeat(CORPUS_INDEX_STEP.BUSY, CORPUS_INDEX_STALL_THRESHOLD * 3),
    );
    expect(stalls).toEqual([
      { kind: "sustained_busy", steps: CORPUS_INDEX_STALL_THRESHOLD },
      { kind: "sustained_busy", steps: CORPUS_INDEX_STALL_THRESHOLD },
      { kind: "sustained_busy", steps: CORPUS_INDEX_STALL_THRESHOLD },
    ]);
  });

  test("failure maps to sustained_failure", () => {
    const { stalls } = foldSequence(
      repeat(CORPUS_INDEX_STEP.FAILED, CORPUS_INDEX_STALL_THRESHOLD),
    );
    expect(stalls).toEqual([
      { kind: "sustained_failure", steps: CORPUS_INDEX_STALL_THRESHOLD },
    ]);
  });

  test("any live step clears both streaks", () => {
    for (const liveKind of [
      CORPUS_INDEX_STEP.ADVANCED,
      CORPUS_INDEX_STEP.COMPLETE,
    ]) {
      const nearStall = [
        ...repeat(CORPUS_INDEX_STEP.BUSY, CORPUS_INDEX_STALL_THRESHOLD - 1),
        ...repeat(CORPUS_INDEX_STEP.FAILED, CORPUS_INDEX_STALL_THRESHOLD - 1),
        liveKind,
      ];
      const { streaks, stalls } = foldSequence(nearStall);
      expect(stalls).toEqual([]);
      expect(streaks).toEqual(INITIAL_CORPUS_INDEX_STREAKS);
    }
  });

  test("busy and failed do not reset each other", () => {
    // A wedge alternating between a leaked lease and a failing backend must
    // still cross a threshold; interleave the two so neither run is ever
    // consecutive, and expect both to report.
    const alternating = Array.from(
      { length: CORPUS_INDEX_STALL_THRESHOLD * 2 },
      (_, index) =>
        index % 2 === 0 ? CORPUS_INDEX_STEP.BUSY : CORPUS_INDEX_STEP.FAILED,
    );
    const { stalls } = foldSequence(alternating);
    expect(stalls).toEqual([
      { kind: "sustained_busy", steps: CORPUS_INDEX_STALL_THRESHOLD },
      { kind: "sustained_failure", steps: CORPUS_INDEX_STALL_THRESHOLD },
    ]);
  });
});
