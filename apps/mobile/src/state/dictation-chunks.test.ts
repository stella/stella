import { describe, expect, test } from "bun:test";

import {
  DICTATION_CHUNK_RULES,
  joinChunks,
  NO_PAUSE,
  watchChunk,
} from "./dictation-chunks";
import type { ChunkWatch } from "./dictation-chunks";

const LOUD = -20;
const QUIET = -60;

/** Readings every 250 ms from `fromMs`, each at the level `levelAt` gives. */
const readings = (
  fromMs: number,
  toMs: number,
  levelAt: (ms: number) => number | undefined,
) => {
  let watch: ChunkWatch = NO_PAUSE;
  for (let pieceMs = fromMs; pieceMs <= toMs; pieceMs += 250) {
    const next = watchChunk(watch, { pieceMs, meteringDb: levelAt(pieceMs) });
    if (next.cut) {
      return pieceMs;
    }
    watch = next.watch;
  }
  return null;
};

const firstReadingAfter = (ms: number) => Math.ceil(ms / 250) * 250;

describe("cutting a long dictation into pieces", () => {
  test("a pause before the minimum length does not cut", () => {
    expect(
      readings(0, 14_750, (ms) => (ms > 5000 && ms < 7000 ? QUIET : LOUD)),
    ).toBeNull();
  });

  test("the first pause after the minimum cuts once it lasts long enough", () => {
    const cutAt = readings(0, 40_000, (ms) =>
      ms >= 20_000 && ms < 22_000 ? QUIET : LOUD,
    );
    // The first reading, every 250 ms, once the pause has lasted.
    expect(cutAt).toBe(
      firstReadingAfter(20_000 + DICTATION_CHUNK_RULES.pauseMs),
    );
  });

  test("a breath shorter than a pause does not cut", () => {
    expect(
      readings(0, 40_000, (ms) => (ms >= 20_000 && ms < 20_400 ? QUIET : LOUD)),
    ).toBeNull();
  });

  test("speech without a pause is cut before the transcription's limit", () => {
    expect(readings(0, 60_000, () => LOUD)).toBe(
      DICTATION_CHUNK_RULES.maximumMs,
    );
  });

  test("a recorder that reports no level is cut at the limit only", () => {
    expect(readings(0, 60_000, () => undefined)).toBe(
      DICTATION_CHUNK_RULES.maximumMs,
    );
  });

  test("a quiet start counts from when the pause began", () => {
    const cutAt = readings(0, 40_000, (ms) => (ms < 30_000 ? LOUD : QUIET));
    expect(cutAt).toBe(
      firstReadingAfter(30_000 + DICTATION_CHUNK_RULES.pauseMs),
    );
  });
});

describe("joining the pieces", () => {
  test("in order, one space between, empty pieces left out", () => {
    expect(joinChunks([" Dobrý den, ", "", "posílám návrh."])).toBe(
      "Dobrý den, posílám návrh.",
    );
  });
});
