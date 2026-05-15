import { describe, expect, test } from "bun:test";

import { clampRangeToDocSize } from "./aiEditRange";

describe("clampRangeToDocSize", () => {
  test("passes a range untouched when both endpoints sit inside the doc", () => {
    expect(clampRangeToDocSize(100, { from: 12, to: 34 })).toEqual({
      from: 12,
      to: 34,
    });
  });

  test("clamps `to` when it points one past the doc end", () => {
    expect(clampRangeToDocSize(100, { from: 50, to: 101 })).toEqual({
      from: 50,
      to: 100,
    });
  });

  test("clamps both endpoints when both exceed the doc", () => {
    expect(clampRangeToDocSize(50, { from: 80, to: 120 })).toEqual({
      from: 50,
      to: 50,
    });
  });

  test("clamps a negative `from` up to zero", () => {
    expect(clampRangeToDocSize(100, { from: -5, to: 20 })).toEqual({
      from: 0,
      to: 20,
    });
  });

  test("preserves a cursor range (from === to)", () => {
    expect(clampRangeToDocSize(100, { from: 42, to: 42 })).toEqual({
      from: 42,
      to: 42,
    });
  });

  test("yields a doc-end cursor when both endpoints are well past the end", () => {
    // `TextSelection.between` falls back to a cursor selection when both
    // endpoints collapse — that is the intended behavior for stale ids.
    expect(clampRangeToDocSize(20, { from: 1000, to: 1500 })).toEqual({
      from: 20,
      to: 20,
    });
  });
});
