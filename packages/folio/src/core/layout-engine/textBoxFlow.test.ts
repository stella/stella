/**
 * Floating text-box predicate tests. Mirrors eigenpal #474.
 */

import { describe, expect, test } from "bun:test";

import {
  floatingTextBoxWrapsText,
  isFloatingTextBoxBlock,
} from "./textBoxFlow";

describe("isFloatingTextBoxBlock", () => {
  test("recognizes displayMode='float' as floating", () => {
    expect(isFloatingTextBoxBlock({ displayMode: "float" })).toBe(true);
  });

  test("recognizes OOXML floating wrap types as floating", () => {
    expect(isFloatingTextBoxBlock({ wrapType: "square" })).toBe(true);
    expect(isFloatingTextBoxBlock({ wrapType: "tight" })).toBe(true);
    expect(isFloatingTextBoxBlock({ wrapType: "through" })).toBe(true);
    expect(isFloatingTextBoxBlock({ wrapType: "behind" })).toBe(true);
    expect(isFloatingTextBoxBlock({ wrapType: "inFront" })).toBe(true);
    expect(isFloatingTextBoxBlock({ wrapType: "topAndBottom" })).toBe(true);
  });

  test("inline text boxes are not floating", () => {
    expect(isFloatingTextBoxBlock({ displayMode: "inline" })).toBe(false);
    expect(isFloatingTextBoxBlock({ wrapType: "inline" })).toBe(false);
    expect(isFloatingTextBoxBlock({})).toBe(false);
  });
});

describe("floatingTextBoxWrapsText", () => {
  test("wraps text for square/tight/through", () => {
    expect(
      floatingTextBoxWrapsText({ displayMode: "float", wrapType: "square" }),
    ).toBe(true);
    expect(
      floatingTextBoxWrapsText({ displayMode: "float", wrapType: "tight" }),
    ).toBe(true);
    expect(
      floatingTextBoxWrapsText({ displayMode: "float", wrapType: "through" }),
    ).toBe(true);
  });

  test("does not wrap text for wrapNone (behind/inFront)", () => {
    expect(floatingTextBoxWrapsText({ wrapType: "behind" })).toBe(false);
    expect(floatingTextBoxWrapsText({ wrapType: "inFront" })).toBe(false);
  });

  test("does not wrap text for topAndBottom", () => {
    expect(floatingTextBoxWrapsText({ wrapType: "topAndBottom" })).toBe(false);
  });

  test("does not wrap text for non-floating blocks", () => {
    expect(floatingTextBoxWrapsText({ displayMode: "inline" })).toBe(false);
    expect(floatingTextBoxWrapsText({})).toBe(false);
  });
});
