import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import {
  MAX_TRANSCRIPTION_AUDIO_SECONDS,
  TRANSCRIPTION_DURATION_TOLERANCE_MS,
} from "@stll/api-contract/transcription";
import { assertProperty } from "@stll/property-testing";

import { readAdmissibleAudioDuration } from "./audio-duration";
import {
  joinAudioBytes,
  makeAudioBox,
  makeM4aAudioBytes,
  makeM4aDurationBox,
  makeWavAudioBytes,
} from "./audio-fixtures.test-helper";

const MAXIMUM =
  MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000 + TRANSCRIPTION_DURATION_TOLERANCE_MS;
const formats = [
  { format: "wav", make: makeWavAudioBytes },
  { format: "m4a", make: makeM4aAudioBytes },
] as const;

const expectUnreadable = (bytes: Uint8Array, format: "wav" | "m4a") => {
  const result = readAdmissibleAudioDuration(bytes, format);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toMatchObject({
      status: 422,
      code: "audio_unreadable",
    });
  }
};

const customM4a = (movie: Uint8Array) =>
  joinAudioBytes([
    makeAudioBox(
      "ftyp",
      new TextEncoder().encode("M4A \u0000\u0000\u0000\u0000"),
    ),
    makeAudioBox("moov", movie),
    makeAudioBox("mdat", new Uint8Array([1])),
  ]);

describe("bounded audio duration", () => {
  for (const { format, make } of formats) {
    test(`${format} reads integer duration through the tolerated boundary`, () => {
      for (const duration of [1, 1234, MAXIMUM - 1, MAXIMUM]) {
        expect(
          readAdmissibleAudioDuration(make(duration), format).unwrap(),
        ).toBe(duration);
      }
      const long = readAdmissibleAudioDuration(make(MAXIMUM + 1), format);
      expect(long.isErr()).toBe(true);
      if (long.isErr()) {
        expect(long.error.code).toBe("audio_too_long");
      }
      expectUnreadable(make(0), format);
    });

    test(`${format} rejects every truncated prefix and trailing garbage`, () => {
      const bytes = make(1);
      for (let end = 0; end < bytes.length; end++) {
        expectUnreadable(bytes.subarray(0, end), format);
      }
      expectUnreadable(joinAudioBytes([bytes, new Uint8Array([1])]), format);
    });
  }

  test("generated WAV duration remains exact for every bounded millisecond", () => {
    assertProperty(
      "generated WAV duration remains exact for every bounded millisecond",
      fc.property(fc.integer({ min: 1, max: MAXIMUM + 1000 }), (duration) => {
        const result = readAdmissibleAudioDuration(
          makeWavAudioBytes(duration),
          "wav",
        );
        if (duration <= MAXIMUM) {
          expect(result.unwrap()).toBe(duration);
        } else {
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error.code).toBe("audio_too_long");
          }
        }
      }),
    );
  });

  test("arbitrary bounded containers return a typed result without out-of-bounds reads", () => {
    assertProperty(
      "arbitrary bounded containers return a typed result without out-of-bounds reads",
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 1024 }), (bytes) => {
        for (const { format } of formats) {
          const result = readAdmissibleAudioDuration(bytes, format);
          if (result.isErr()) {
            expect(result.error.status).toBe(422);
          } else {
            expect(result.value).toBeGreaterThan(0);
            expect(result.value).toBeLessThanOrEqual(MAXIMUM);
          }
        }
      }),
    );
  });
});

describe("WAV duration structure", () => {
  test("validates PCM and floating point format arithmetic", () => {
    for (const [encoding, bits] of [
      [1, 8],
      [1, 16],
      [1, 24],
      [1, 32],
      [3, 32],
      [3, 64],
    ] as const) {
      const bytes = makeWavAudioBytes(3);
      const view = new DataView(bytes.buffer);
      view.setUint16(20, encoding, true);
      view.setUint16(34, bits, true);
      view.setUint16(32, bits / 8, true);
      view.setUint32(28, (16_000 * bits) / 8, true);
      expect(readAdmissibleAudioDuration(bytes, "wav").isOk()).toBe(true);
    }
    for (const mutation of [
      (view: DataView) => view.setUint16(20, 2, true),
      (view: DataView) => view.setUint16(22, 0, true),
      (view: DataView) => view.setUint32(24, 0, true),
      (view: DataView) => view.setUint32(28, 1, true),
      (view: DataView) => view.setUint16(32, 1, true),
      (view: DataView) => view.setUint16(34, 12, true),
      (view: DataView) => view.setUint32(40, 1, true),
    ]) {
      const bytes = makeWavAudioBytes(10);
      mutation(new DataView(bytes.buffer));
      expectUnreadable(bytes, "wav");
    }
  });

  test("rejects duplicate format/data chunks and inconsistent declared size", () => {
    const base = makeWavAudioBytes(1);
    for (const duplicate of [base.subarray(12, 36), base.subarray(36)]) {
      const bytes = joinAudioBytes([base, duplicate]);
      new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
      expectUnreadable(bytes, "wav");
    }
    for (const declared of [
      0,
      base.length - 9,
      base.length - 7,
      0xff_ff_ff_ff,
    ]) {
      const bytes = base.slice();
      new DataView(bytes.buffer).setUint32(4, declared, true);
      expectUnreadable(bytes, "wav");
    }
  });

  test("requires odd chunk padding and bounds the chunk count", () => {
    const base = makeWavAudioBytes(1);
    const odd = new Uint8Array(10);
    odd.set(new TextEncoder().encode("JUNK"));
    new DataView(odd.buffer).setUint32(4, 1, true);
    const valid = joinAudioBytes([
      base.subarray(0, 12),
      odd,
      base.subarray(12),
    ]);
    new DataView(valid.buffer).setUint32(4, valid.length - 8, true);
    expect(readAdmissibleAudioDuration(valid, "wav").unwrap()).toBe(1);
    const invalid = joinAudioBytes([
      base.subarray(0, 12),
      odd.subarray(0, 9),
      base.subarray(12),
    ]);
    new DataView(invalid.buffer).setUint32(4, invalid.length - 8, true);
    expectUnreadable(invalid, "wav");
    const empty = new Uint8Array(8);
    empty.set(new TextEncoder().encode("JUNK"));
    const excessive = joinAudioBytes([
      base,
      ...Array.from({ length: 4097 }, () => empty),
    ]);
    new DataView(excessive.buffer).setUint32(4, excessive.length - 8, true);
    expectUnreadable(excessive, "wav");
  });
});

describe("M4A duration structure", () => {
  test("rounds fractional timescales upward and rejects huge version-one durations", () => {
    for (const version of [0, 1] as const) {
      const box = makeM4aDurationBox({ type: "mvhd", durationMs: 2, version });
      new DataView(box.buffer).setUint32(8 + (version === 0 ? 12 : 20), 3);
      expect(readAdmissibleAudioDuration(customM4a(box), "m4a").unwrap()).toBe(
        667,
      );
    }
    const huge = makeM4aDurationBox({
      type: "mvhd",
      durationMs: 1,
      version: 1,
    });
    new DataView(huge.buffer).setBigUint64(32, 0xff_ff_ff_ff_ff_ff_ff_fen);
    const result = readAdmissibleAudioDuration(customM4a(huge), "m4a");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("audio_too_long");
    }
  });

  test("inspects every track instead of trusting a short first track", () => {
    const movie = makeM4aDurationBox({ type: "mvhd", durationMs: 1000 });
    const short = makeAudioBox(
      "trak",
      makeAudioBox(
        "mdia",
        makeM4aDurationBox({ type: "mdhd", durationMs: 1000 }),
      ),
    );
    const long = makeAudioBox(
      "trak",
      makeAudioBox(
        "mdia",
        makeM4aDurationBox({ type: "mdhd", durationMs: MAXIMUM + 1 }),
      ),
    );
    for (const tracks of [
      [short, long],
      [long, short],
    ]) {
      const result = readAdmissibleAudioDuration(
        customM4a(joinAudioBytes([movie, ...tracks])),
        "m4a",
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("audio_too_long");
      }
    }
  });

  test("uses the maximum movie/track duration for both metadata versions", () => {
    for (const version of [0, 1] as const) {
      expect(
        readAdmissibleAudioDuration(
          makeM4aAudioBytes(1234, { version }),
          "m4a",
        ).unwrap(),
      ).toBe(1234);
      for (const options of [
        { movieDurationMs: 1000, trackDurationMs: MAXIMUM + 1, version },
        { movieDurationMs: MAXIMUM + 1, trackDurationMs: 1000, version },
      ]) {
        const result = readAdmissibleAudioDuration(
          makeM4aAudioBytes(1000, options),
          "m4a",
        );
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.code).toBe("audio_too_long");
        }
      }
    }
  });

  test("M4A duration cannot hide a longer track behind a shorter movie", () => {
    assertProperty(
      "M4A duration cannot hide a longer track behind a shorter movie",
      fc.property(
        fc.tuple(
          fc.integer({ min: 1, max: MAXIMUM + 1 }),
          fc.integer({ min: 1, max: MAXIMUM + 1 }),
          fc.constantFrom(0, 1),
        ),
        ([movieDurationMs, trackDurationMs, version]) => {
          const result = readAdmissibleAudioDuration(
            makeM4aAudioBytes(1, { movieDurationMs, trackDurationMs, version }),
            "m4a",
          );
          const maximum = Math.max(movieDurationMs, trackDurationMs);
          if (maximum <= MAXIMUM) {
            expect(result.unwrap()).toBe(maximum);
          } else {
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
              expect(result.error.code).toBe("audio_too_long");
            }
          }
        },
      ),
    );
  });

  test("rejects unknown, zero, or truncated duration metadata", () => {
    for (const version of [0, 1] as const) {
      for (const field of [
        "version",
        "scale",
        "unknown",
        "zero",
        "flags",
      ] as const) {
        const box = makeM4aDurationBox({
          type: "mvhd",
          durationMs: 1234,
          version,
        });
        const view = new DataView(box.buffer);
        const scale = 8 + (version === 0 ? 12 : 20);
        if (field === "version") {
          box[8] = 2;
        }
        if (field === "flags") {
          box[9] = 1;
        }
        if (field === "scale") {
          view.setUint32(scale, 0);
        }
        if (field === "zero") {
          if (version === 0) {
            view.setUint32(scale + 4, 0);
          } else {
            view.setBigUint64(scale + 4, 0n);
          }
        }
        if (field === "unknown") {
          if (version === 0) {
            view.setUint32(scale + 4, 0xff_ff_ff_ff);
          } else {
            view.setBigUint64(scale + 4, 0xff_ff_ff_ff_ff_ff_ff_ffn);
          }
        }
        expectUnreadable(customM4a(box), "m4a");
      }
    }
    expectUnreadable(
      customM4a(makeAudioBox("mvhd", new Uint8Array(10))),
      "m4a",
    );
    expectUnreadable(customM4a(makeAudioBox("free", new Uint8Array())), "m4a");
    const noMedia = makeM4aAudioBytes().subarray(
      0,
      makeM4aAudioBytes().length - 14,
    );
    expectUnreadable(noMedia, "m4a");
  });

  test("handles extended and zero box sizes while rejecting bad boundaries and fragmented streams", () => {
    const movie = makeM4aDurationBox({ type: "mvhd", durationMs: 1234 });
    const extended = new Uint8Array(movie.length + 8);
    const view = new DataView(extended.buffer);
    view.setUint32(0, 1);
    extended.set(new TextEncoder().encode("mvhd"), 4);
    view.setBigUint64(8, BigInt(extended.length));
    extended.set(movie.subarray(8), 16);
    expect(
      readAdmissibleAudioDuration(customM4a(extended), "m4a").unwrap(),
    ).toBe(1234);
    const zero = movie.slice();
    new DataView(zero.buffer).setUint32(0, 0);
    expect(readAdmissibleAudioDuration(customM4a(zero), "m4a").unwrap()).toBe(
      1234,
    );
    for (const size of [2, 7, movie.length + 1, 0xff_ff_ff_ff]) {
      const invalid = movie.slice();
      new DataView(invalid.buffer).setUint32(0, size);
      expectUnreadable(customM4a(invalid), "m4a");
    }
    for (const size of [
      0n,
      15n,
      BigInt(extended.length + 1),
      0xff_ff_ff_ff_ff_ff_ff_ffn,
    ]) {
      const invalid = extended.slice();
      new DataView(invalid.buffer).setBigUint64(8, size);
      expectUnreadable(customM4a(invalid), "m4a");
    }
    for (const kind of ["mvex", "moof"]) {
      expectUnreadable(
        customM4a(
          joinAudioBytes([movie, makeAudioBox(kind, new Uint8Array())]),
        ),
        "m4a",
      );
    }
    expectUnreadable(customM4a(makeAudioBox("moov", movie)), "m4a");
    expectUnreadable(customM4a(joinAudioBytes([movie, movie])), "m4a");
    expectUnreadable(
      customM4a(
        joinAudioBytes([
          movie,
          ...Array.from({ length: 4097 }, () =>
            makeAudioBox("free", new Uint8Array()),
          ),
        ]),
      ),
      "m4a",
    );
  });

  test("arbitrary box size declarations stay inside their parent", () => {
    assertProperty(
      "arbitrary box size declarations stay inside their parent",
      fc.property(fc.integer({ min: 8, max: 0xff_ff_ff_ff }), (size) => {
        const movie = makeM4aDurationBox({ type: "mvhd", durationMs: 1234 });
        new DataView(movie.buffer).setUint32(0, size);
        const result = readAdmissibleAudioDuration(customM4a(movie), "m4a");
        if (size === movie.length) {
          expect(result.unwrap()).toBe(1234);
        } else {
          expect(result.isErr()).toBe(true);
        }
      }),
    );
  });
});
