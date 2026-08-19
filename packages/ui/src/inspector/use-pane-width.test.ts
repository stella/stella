import { describe, expect, test } from "bun:test";

import {
  INSPECTOR_PANE_DEFAULT_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
} from "./pane-width";
import { parsePersistedPaneWidth, resolveDragWidth } from "./use-pane-width";

describe("parsePersistedPaneWidth", () => {
  test("returns the default when nothing was persisted", () => {
    expect(parsePersistedPaneWidth(null)).toBe(INSPECTOR_PANE_DEFAULT_WIDTH);
  });

  test("restores a width inside the pane's own bounds", () => {
    expect(parsePersistedPaneWidth("640")).toBe(640);
    expect(parsePersistedPaneWidth(String(INSPECTOR_PANE_MIN_WIDTH))).toBe(
      INSPECTOR_PANE_MIN_WIDTH,
    );
    expect(parsePersistedPaneWidth(String(INSPECTOR_PANE_MAX_WIDTH))).toBe(
      INSPECTOR_PANE_MAX_WIDTH,
    );
  });

  // A corrupt entry must not strand the pane at a width the handle cannot
  // recover from, so it falls back rather than being clamped.
  test("rejects junk and out-of-range widths", () => {
    for (const raw of ["", "abc", "NaN", "-1", "0", "10", "5000", "1e9"]) {
      expect(parsePersistedPaneWidth(raw)).toBe(INSPECTOR_PANE_DEFAULT_WIDTH);
    }
  });
});

describe("resolveDragWidth", () => {
  test("measures from the inline-end edge in LTR", () => {
    expect(
      resolveDragWidth({ clientX: 1400, isRtl: false, viewportWidth: 1920 }),
    ).toBe(520);
  });

  test("measures from the inline-start edge in RTL", () => {
    expect(
      resolveDragWidth({ clientX: 520, isRtl: true, viewportWidth: 1920 }),
    ).toBe(520);
  });

  // Without the RTL branch the delta inverts and the drag oscillates.
  test("both directions agree for a mirrored pointer position", () => {
    const viewportWidth = 1440;
    const ltr = resolveDragWidth({
      clientX: viewportWidth - 400,
      isRtl: false,
      viewportWidth,
    });
    const rtl = resolveDragWidth({ clientX: 400, isRtl: true, viewportWidth });
    expect(ltr).toBe(rtl);
  });
});
