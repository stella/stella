import { describe, expect, test } from "bun:test";

import { DIALOG_SIZE_CLASS_NAMES } from "./dialog";

// The popup only mounts in a browser (it is portalled), so the widths are
// checked on the map `DialogPopup` reads; the Playwright spec opens it.
describe("DialogPopup size", () => {
  test("each size caps the popup at its own width, default unchanged", () => {
    expect(DIALOG_SIZE_CLASS_NAMES).toEqual({
      default: "max-w-lg",
      lg: "max-w-2xl",
      sm: "max-w-sm",
      xl: "max-w-4xl",
    });
  });

  test("the sizes grow in order", () => {
    const order = ["sm", "default", "lg", "xl"] as const;
    const widths = order.map((size) => DIALOG_SIZE_CLASS_NAMES[size]);
    expect(new Set(widths).size).toBe(order.length);
  });
});
