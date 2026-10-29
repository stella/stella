import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { recordingSignal, waveformLevel } from "./signal";

const START = 1_793_270_000_000;
const recording = {
  status: "recording",
  recordingSince: START,
  lastMeterAt: START,
  db: -24,
} as const;

describe("dictation signal", () => {
  test("a silent microphone remains silence while samples arrive", () => {
    expect(recordingSignal({ ...recording, now: START + 599, db: -96 })).toBe(
      "silence",
    );
    expect(recordingSignal({ ...recording, now: START + 599, db: -54 })).toBe(
      "silence",
    );
    expect(recordingSignal({ ...recording, now: START + 599, db: -53 })).toBe(
      "speech-or-noise",
    );
  });

  test("missing updates become no signal at exactly 600 milliseconds", () => {
    expect(recordingSignal({ ...recording, now: START + 599 })).toBe(
      "speech-or-noise",
    );
    expect(recordingSignal({ ...recording, now: START + 600 })).toBe(
      "no-signal",
    );
    expect(recordingSignal({ ...recording, now: START + 600, db: -96 })).toBe(
      "no-signal",
    );
  });

  test("a microphone that never opens gets the same 600 millisecond grace", () => {
    expect(
      recordingSignal({
        ...recording,
        lastMeterAt: null,
        now: START + 599,
        db: -96,
      }),
    ).toBe("silence");
    expect(
      recordingSignal({
        ...recording,
        lastMeterAt: null,
        now: START + 600,
        db: -96,
      }),
    ).toBe("no-signal");
  });

  test("new samples restore the signal without an explicit reset", () => {
    const now = START + 2000;
    expect(recordingSignal({ ...recording, now })).toBe("no-signal");
    expect(
      recordingSignal({ ...recording, now, lastMeterAt: now, db: -96 }),
    ).toBe("silence");
    expect(recordingSignal({ ...recording, now, lastMeterAt: now })).toBe(
      "speech-or-noise",
    );
  });

  test("an interruption can pause cleanly and resume with fresh opening grace", () => {
    const now = START + 2000;
    expect(recordingSignal({ ...recording, now })).toBe("no-signal");
    expect(
      recordingSignal({
        ...recording,
        now,
        status: "paused",
        recordingSince: null,
      }),
    ).toBe("silence");
    expect(
      recordingSignal({
        ...recording,
        now: now + 599,
        recordingSince: now,
        lastMeterAt: null,
        db: -96,
      }),
    ).toBe("silence");
    expect(
      recordingSignal({
        ...recording,
        now: now + 599,
        recordingSince: now,
        lastMeterAt: START,
        db: -96,
      }),
    ).toBe("silence");
    expect(
      recordingSignal({
        ...recording,
        now: now + 600,
        recordingSince: now,
        lastMeterAt: now + 600,
      }),
    ).toBe("speech-or-noise");
    expect(
      recordingSignal({
        ...recording,
        now,
        status: "finished",
        recordingSince: null,
      }),
    ).toBe("silence");
  });

  test("fresh signal classification is independent of recording age", () => {
    assertProperty(
      "fresh signal classification is independent of recording age",
      fc.property(
        fc.integer({ min: 0, max: 86_400_000 }),
        fc.integer({ min: 0, max: 599 }),
        fc.integer({ min: -160, max: 0 }),
        (age, delay, db) => {
          const lastMeterAt = START + age;
          expect(
            recordingSignal({
              ...recording,
              lastMeterAt,
              now: lastMeterAt + delay,
              db,
            }),
          ).toBe(db <= -54 ? "silence" : "speech-or-noise");
          expect(
            recordingSignal({
              ...recording,
              lastMeterAt,
              now: lastMeterAt + 600,
              db,
            }),
          ).toBe("no-signal");
        },
      ),
    );
  });
});

describe("dictation waveform buckets", () => {
  test("silence is a dot and speech has a bounded height", () => {
    expect(waveformLevel(-96)).toBe(0);
    expect(waveformLevel(-54)).toBe(0);
    expect(waveformLevel(-33)).toBe(0.5);
    expect(waveformLevel(-12)).toBe(1);
    expect(waveformLevel(0)).toBe(1);
  });

  test("louder buckets never become shorter and every height stays bounded", () => {
    assertProperty(
      "louder buckets never become shorter and every height stays bounded",
      fc.property(
        fc.double({ min: -160, max: 0, noNaN: true }),
        fc.double({ min: -160, max: 0, noNaN: true }),
        (first, second) => {
          const quieter = waveformLevel(Math.min(first, second));
          const louder = waveformLevel(Math.max(first, second));
          expect(quieter).toBeGreaterThanOrEqual(0);
          expect(louder).toBeLessThanOrEqual(1);
          expect(quieter).toBeLessThanOrEqual(louder);
        },
      ),
    );
  });
});
