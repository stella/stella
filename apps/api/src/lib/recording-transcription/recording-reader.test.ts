import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { RecordingPiece, RecordingRefusal } from "@stll/recording-wasm";

import { openRecordingReader } from "./recording-reader";
import { toneWav } from "./tone-wav.test-helper";

const readAll = async (
  bytes: Uint8Array,
  extension: string | null,
): Promise<
  Result<
    { durationMs: number | null; pieces: RecordingPiece[] },
    RecordingRefusal
  >
> => {
  const opened = await openRecordingReader({
    bytes: bytes.slice().buffer,
    extension,
  });
  if (Result.isError(opened)) {
    return Result.err(opened.error);
  }
  const pieces: RecordingPiece[] = [];
  try {
    for (;;) {
      const read = await opened.value.next();
      if (Result.isError(read)) {
        return Result.err(read.error);
      }
      if (read.value === null) {
        return Result.ok({ durationMs: opened.value.durationMs, pieces });
      }
      pieces.push(read.value);
    }
  } finally {
    await opened.value.close();
  }
};

describe("recording reader", () => {
  test("hands out a recording's pieces in order, off the main thread", async () => {
    const read = await readAll(toneWav(60), "wav");
    if (Result.isError(read)) {
      throw new TypeError(`refused: ${read.error}`);
    }
    expect(read.value.durationMs).toBe(60_000);
    expect(read.value.pieces.length).toBeGreaterThan(1);
    expect(read.value.pieces.map(({ index }) => index)).toEqual(
      read.value.pieces.map((_, index) => index),
    );
    expect(read.value.pieces.at(-1)?.endMs).toBe(60_000);
    expect(read.value.pieces.every(({ speech }) => speech)).toBe(true);
    expect(
      read.value.pieces.every(
        ({ wav }) => new TextDecoder().decode(wav.subarray(0, 4)) === "RIFF",
      ),
    ).toBe(true);
  });

  test("refuses bytes that are not a recording", async () => {
    const read = await readAll(new TextEncoder().encode("not audio"), "mp3");
    expect(Result.isError(read)).toBe(true);
  });
});
