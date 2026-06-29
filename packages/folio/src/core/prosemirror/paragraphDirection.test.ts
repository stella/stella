import { describe, expect, test } from "bun:test";

import {
  directionFromBidi,
  directionIsAutoManaged,
  directionIsRtl,
  directionToBidi,
  isParagraphDirection,
  type ParagraphDirection,
} from "./paragraphDirection";

const AUTO: ParagraphDirection = { source: "auto" };
const RTL: ParagraphDirection = { source: "manual", value: "rtl" };
const LTR: ParagraphDirection = { source: "manual", value: "ltr" };

describe("directionIsRtl", () => {
  test("auto and manual-rtl are RTL; manual-ltr and undecided are not", () => {
    expect(directionIsRtl(AUTO)).toBe(true);
    expect(directionIsRtl(RTL)).toBe(true);
    expect(directionIsRtl(LTR)).toBe(false);
    expect(directionIsRtl(null)).toBe(false);
    expect(directionIsRtl(undefined)).toBe(false);
  });
});

describe("directionIsAutoManaged", () => {
  test("undecided and auto are auto-managed; manual is not", () => {
    expect(directionIsAutoManaged(null)).toBe(true);
    expect(directionIsAutoManaged(undefined)).toBe(true);
    expect(directionIsAutoManaged(AUTO)).toBe(true);
    expect(directionIsAutoManaged(RTL)).toBe(false);
    expect(directionIsAutoManaged(LTR)).toBe(false);
  });
});

describe("directionToBidi", () => {
  test("maps to the OOXML w:bidi tri-state", () => {
    expect(directionToBidi(AUTO)).toBe(true);
    expect(directionToBidi(RTL)).toBe(true);
    expect(directionToBidi(LTR)).toBe(false);
    expect(directionToBidi(null)).toBeUndefined();
    expect(directionToBidi(undefined)).toBeUndefined();
  });
});

describe("directionFromBidi", () => {
  test("an explicit bidi is a manual decision; absence is undecided", () => {
    expect(directionFromBidi(true)).toEqual(RTL);
    expect(directionFromBidi(false)).toEqual(LTR);
    expect(directionFromBidi(null)).toBeNull();
    expect(directionFromBidi(undefined)).toBeNull();
  });

  test("round-trips through directionToBidi", () => {
    for (const bidi of [true, false] as const) {
      expect(directionToBidi(directionFromBidi(bidi))).toBe(bidi);
    }
  });
});

describe("isParagraphDirection", () => {
  test("accepts valid shapes", () => {
    expect(isParagraphDirection(AUTO)).toBe(true);
    expect(isParagraphDirection(RTL)).toBe(true);
    expect(isParagraphDirection(LTR)).toBe(true);
  });

  test("rejects invalid shapes", () => {
    expect(isParagraphDirection(null)).toBe(false);
    expect(isParagraphDirection(undefined)).toBe(false);
    expect(isParagraphDirection(true)).toBe(false);
    expect(isParagraphDirection("rtl")).toBe(false);
    expect(isParagraphDirection({})).toBe(false);
    expect(isParagraphDirection({ source: "manual" })).toBe(false);
    expect(isParagraphDirection({ source: "manual", value: "x" })).toBe(false);
    expect(isParagraphDirection({ source: "other" })).toBe(false);
    // `auto` must not carry a payload — that is the illegal state this union
    // is meant to forbid.
    expect(isParagraphDirection({ source: "auto", value: "ltr" })).toBe(false);
  });
});
