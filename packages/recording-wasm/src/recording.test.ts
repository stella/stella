import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";

import {
  initRecordingReader,
  openRecording,
  RECORDING_WASM_URL,
} from "./recording";
import type { RecordingPiece } from "./recording";

const RATE = 44_100;

/** Mono 16-bit WAV: a loud tone for four seconds, then a second of quiet. */
const toneWav = (seconds: number): Uint8Array => {
  const samples = seconds * RATE;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    bytes.set(new TextEncoder().encode(text), offset);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const quiet = Math.floor(index / RATE) % 5 === 4;
    const value = quiet
      ? 0
      : Math.round(Math.sin((index * 440 * 2 * Math.PI) / RATE) * 16_000);
    view.setInt16(44 + index * 2, value, true);
  }
  return bytes;
};

async function* inSlices(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

beforeAll(async () => {
  initRecordingReader(
    await WebAssembly.compile(await Bun.file(RECORDING_WASM_URL).arrayBuffer()),
  );
});

describe("openRecording", () => {
  test("hands out ordered 16 kHz WAV pieces that cover the recording", async () => {
    const wav = toneWav(120);
    const opened = await openRecording({
      size: wav.length,
      chunks: inSlices(wav, 64 * 1024),
      extension: "wav",
    });
    if (opened.isErr()) {
      panic(opened.error.message);
    }
    const recording = opened.value;
    expect(recording.format).toBe("WAV");
    expect(recording.durationMs).toBe(120_000);
    const pieces: RecordingPiece[] = [];
    for (;;) {
      const next = recording.next();
      if (next.isErr()) {
        panic(next.error.message);
      }
      if (next.value === null) {
        break;
      }
      pieces.push(next.value);
    }
    recording.close();
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(pieces.map((piece) => piece.index)).toEqual(
      pieces.map((_piece, index) => index),
    );
    expect(pieces[0]?.startMs).toBe(0);
    for (const [index, piece] of pieces.entries()) {
      expect(piece.endMs - piece.startMs).toBeLessThanOrEqual(55_000);
      expect(piece.speech).toBe(true);
      const view = new DataView(piece.wav.buffer, piece.wav.byteOffset);
      expect(view.getUint32(24, true)).toBe(16_000);
      expect(piece.wav.length).toBe(
        44 + Math.round(((piece.endMs - piece.startMs) / 1000) * 16_000) * 2,
      );
      if (index > 0) {
        expect(piece.startMs).toBe(pieces[index - 1]?.endMs ?? -1);
      }
    }
    expect(pieces.at(-1)?.endMs).toBeGreaterThan(119_900);
  });

  test("refuses bytes that are no recording", async () => {
    const bytes = new TextEncoder().encode("not a recording at all");
    const opened = await openRecording({
      size: bytes.length,
      chunks: inSlices(bytes, 8),
      extension: "m4a",
    });
    expect(opened.isErr() && opened.error.refusal).toBe("unsupported");
  });

  test("refuses content longer or shorter than its declared size", async () => {
    const wav = toneWav(1);
    const longer = await openRecording({
      size: wav.length - 1,
      chunks: inSlices(wav, 1024),
      extension: "wav",
    });
    expect(longer.isErr() && longer.error.refusal).toBe("unreadable");
    const shorter = await openRecording({
      size: wav.length + 1,
      chunks: inSlices(wav, 1024),
      extension: "wav",
    });
    expect(shorter.isErr() && shorter.error.refusal).toBe("unreadable");
  });
});
