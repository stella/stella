import { describe, expect, test } from "bun:test";

import {
  INSPECTOR_PANE_DEFAULT_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
} from "./pane-width";
import {
  INSPECTOR_PANE_KEYBOARD_PAGE_STEP,
  INSPECTOR_PANE_KEYBOARD_STEP,
  resolveKeyboardWidth,
} from "./use-pane-width";

const at = (key: string, isRtl = false) =>
  resolveKeyboardWidth({ currentWidth: 512, isRtl, key });

describe("resolveKeyboardWidth", () => {
  // The arrow follows the edge, not the width: on an inline-end pane the
  // inline-start arrow grows it, and RTL swaps which physical key that is.
  test("the inline-start arrow grows the pane in both directions", () => {
    expect(at("ArrowLeft")).toBe(512 + INSPECTOR_PANE_KEYBOARD_STEP);
    expect(at("ArrowRight", true)).toBe(512 + INSPECTOR_PANE_KEYBOARD_STEP);
  });

  test("the inline-end arrow shrinks the pane in both directions", () => {
    expect(at("ArrowRight")).toBe(512 - INSPECTOR_PANE_KEYBOARD_STEP);
    expect(at("ArrowLeft", true)).toBe(512 - INSPECTOR_PANE_KEYBOARD_STEP);
  });

  test("page keys move further than arrows", () => {
    expect(at("PageUp")).toBe(512 + INSPECTOR_PANE_KEYBOARD_PAGE_STEP);
    expect(at("PageDown")).toBe(512 - INSPECTOR_PANE_KEYBOARD_PAGE_STEP);
    expect(INSPECTOR_PANE_KEYBOARD_PAGE_STEP).toBeGreaterThan(
      INSPECTOR_PANE_KEYBOARD_STEP,
    );
  });

  test("Home and End jump to the pane's own bounds", () => {
    expect(at("Home")).toBe(INSPECTOR_PANE_MIN_WIDTH);
    expect(at("End")).toBe(INSPECTOR_PANE_MAX_WIDTH);
  });

  test("Enter restores the default, mirroring double-click", () => {
    expect(at("Enter")).toBe(INSPECTOR_PANE_DEFAULT_WIDTH);
  });

  // A focusable separator receives every keystroke aimed at it; swallowing
  // the ones it does not own would trap Tab and the app's shortcuts.
  test("leaves keys the handle does not own alone", () => {
    for (const key of ["Tab", "Escape", "a", " ", "F5", "ArrowUp"]) {
      expect(at(key)).toBeNull();
    }
  });
});
