import { describe, expect, test } from "bun:test";

import { nativeButtonClassNames } from "./button.native-classes";
import { BUTTON_PLAIN_VARIANT, type ButtonVariant } from "./button.shared";

const look = (variant: ButtonVariant, selected: boolean) =>
  nativeButtonClassNames({ inactive: false, selected, variant });

describe("native Button selected", () => {
  test("a selected plain button colours the border it always keeps", () => {
    const unselected = look(BUTTON_PLAIN_VARIANT, false).pressable;
    const selected = look(BUTTON_PLAIN_VARIANT, true).pressable;

    expect(unselected).toContain("border-2");
    expect(unselected).toContain("border-transparent");
    expect(selected).toContain("border-2");
    expect(selected).toContain("border-primary");
    expect(selected).not.toBe(unselected);
  });

  test("a plain button does not dim when disabled", () => {
    expect(
      nativeButtonClassNames({
        inactive: true,
        selected: false,
        variant: BUTTON_PLAIN_VARIANT,
      }).pressable,
    ).not.toContain("opacity-64");
  });
});
