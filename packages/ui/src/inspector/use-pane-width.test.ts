import { describe, expect, test } from "bun:test";

import { resolveDragWidth } from "./use-pane-width";

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
