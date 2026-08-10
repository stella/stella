import { describe, expect, test } from "bun:test";

import {
  CORPUS_INDEX_STALL_WINDOW_MS,
  CORPUS_INDEX_STEP,
  type CorpusIndexStepKind,
  type CorpusIndexStreaks,
  INITIAL_CORPUS_INDEX_STREAKS,
  corpusIndexStallThreshold,
  stepCorpusIndexProgress,
} from "./corpus-index-progress";

const THRESHOLD = 4;

/** Fold a whole step sequence, collecting every reported stall. */
const foldSequence = (kinds: readonly CorpusIndexStepKind[]) => {
  let streaks: CorpusIndexStreaks = INITIAL_CORPUS_INDEX_STREAKS;
  const stalls: NonNullable<
    ReturnType<typeof stepCorpusIndexProgress>["stall"]
  >[] = [];
  for (const kind of kinds) {
    const step = stepCorpusIndexProgress({
      kind,
      streaks,
      threshold: THRESHOLD,
    });
    streaks = step.streaks;
    if (step.stall) {
      stalls.push(step.stall);
    }
  }
  return { stalls, streaks };
};

const repeat = (kind: CorpusIndexStepKind, count: number) =>
  Array.from({ length: count }, () => kind);

describe("corpusIndexStallThreshold", () => {
  test("expresses the stall window in steps of the configured interval", () => {
    expect(corpusIndexStallThreshold(15_000)).toBe(
      CORPUS_INDEX_STALL_WINDOW_MS / 15_000,
    );
    // The fastest supported interval must not report within seconds.
    expect(corpusIndexStallThreshold(250) * 250).toBeGreaterThanOrEqual(
      CORPUS_INDEX_STALL_WINDOW_MS,
    );
  });

  test("never lets a single step report, even past the window", () => {
    for (const intervalMs of [CORPUS_INDEX_STALL_WINDOW_MS, 600_000]) {
      expect(corpusIndexStallThreshold(intervalMs)).toBe(2);
    }
  });
});

describe("stepCorpusIndexProgress", () => {
  test("a streak one short of the threshold reports nothing", () => {
    for (const kind of [CORPUS_INDEX_STEP.BUSY, CORPUS_INDEX_STEP.FAILED]) {
      const { stalls } = foldSequence(repeat(kind, THRESHOLD - 1));
      expect(stalls).toEqual([]);
    }
  });

  test("a sustained condition reports once per threshold-run, not per step", () => {
    const { stalls } = foldSequence(
      repeat(CORPUS_INDEX_STEP.BUSY, THRESHOLD * 3),
    );
    expect(stalls).toEqual([
      { kind: "sustained_busy", steps: THRESHOLD },
      { kind: "sustained_busy", steps: THRESHOLD },
      { kind: "sustained_busy", steps: THRESHOLD },
    ]);
  });

  test("failure maps to sustained_failure", () => {
    const { stalls } = foldSequence(
      repeat(CORPUS_INDEX_STEP.FAILED, THRESHOLD),
    );
    expect(stalls).toEqual([{ kind: "sustained_failure", steps: THRESHOLD }]);
  });

  test("any live step clears both streaks", () => {
    for (const liveKind of [
      CORPUS_INDEX_STEP.ADVANCED,
      CORPUS_INDEX_STEP.COMPLETE,
    ]) {
      const nearStall = [
        ...repeat(CORPUS_INDEX_STEP.BUSY, THRESHOLD - 1),
        ...repeat(CORPUS_INDEX_STEP.FAILED, THRESHOLD - 1),
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
    const alternating = Array.from({ length: THRESHOLD * 2 }, (_, index) =>
      index % 2 === 0 ? CORPUS_INDEX_STEP.BUSY : CORPUS_INDEX_STEP.FAILED,
    );
    const { stalls } = foldSequence(alternating);
    expect(stalls).toEqual([
      { kind: "sustained_busy", steps: THRESHOLD },
      { kind: "sustained_failure", steps: THRESHOLD },
    ]);
  });
});
