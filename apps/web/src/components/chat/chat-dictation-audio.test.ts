import { describe, expect, test } from "bun:test";

import {
  encodeWav,
  mixChannelsToMono,
} from "@/components/chat/chat-dictation-audio";

describe("encodeWav", () => {
  test("writes a mono 16-bit PCM WAV the transcription route can read", async () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
    const view = new DataView(await wav.arrayBuffer());
    const tag = (offset: number) =>
      new TextDecoder("ascii").decode(new Uint8Array(view.buffer, offset, 4));

    expect(wav.type).toBe("audio/wav");
    expect(view.byteLength).toBe(44 + 8);
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual([
      "RIFF",
      "WAVE",
      "fmt ",
      "data",
    ]);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 32_767, -32_768, 32_767,
    ]);
  });
});

describe("mixChannelsToMono", () => {
  test("averages channels and caps the output at maxSamples", () => {
    const left = new Float32Array([0.2, 0.4, 0.6, 0.8]);
    const right = new Float32Array([0.6, 0.8, 1, 1]);
    const mono = mixChannelsToMono([left, right], 2);

    expect(mono.length).toBe(2);
    expect(mono[0]).toBeCloseTo(0.4, 5);
    expect(mono[1]).toBeCloseTo(0.6, 5);
  });
});
