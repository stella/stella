import { describe, expect, test } from "bun:test";

import {
  DICTATION_LEVEL_RULES,
  meterShare,
  SIGNAL_UNKNOWN,
  watchSignal,
} from "./dictation-level";
import type { SignalWatch } from "./dictation-level";

/** Feeds readings every 250 ms, as the recorder reports them, and says what each one tells. */
const readings = (levels: readonly (number | undefined)[]): boolean[] => {
  let watch: SignalWatch = SIGNAL_UNKNOWN;
  return levels.map((meteringDb, index) => {
    const next = watchSignal(watch, { atMs: (index + 1) * 250, meteringDb });
    watch = next.watch;
    return next.noSignal;
  });
};

describe("dictation level", () => {
  test("the meter runs from a quiet room to a raised voice", () => {
    expect(meterShare(undefined)).toBe(0);
    expect(meterShare(DICTATION_LEVEL_RULES.floorDb)).toBe(0);
    expect(meterShare(DICTATION_LEVEL_RULES.quietDb)).toBe(0);
    expect(meterShare(-32.5)).toBeCloseTo(0.5);
    expect(meterShare(DICTATION_LEVEL_RULES.loudDb)).toBe(1);
    expect(meterShare(0)).toBe(1);
  });

  test("a microphone at its floor for 600 ms gives no signal", () => {
    const floor = DICTATION_LEVEL_RULES.floorDb;
    expect(readings([floor, floor, floor, floor])).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  test("a quiet room is a signal, and any sound starts the wait again", () => {
    const floor = DICTATION_LEVEL_RULES.floorDb;
    expect(readings([-70, -70, -70, -70, -70])).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(readings([floor, floor, -40, floor, floor, floor, floor])).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  test("a recorder that reports no level says nothing about the signal", () => {
    expect(readings([undefined, undefined, undefined, undefined])).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
