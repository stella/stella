import { describe, expect, test } from "bun:test";

import { buttonVariants } from "./button";
import { BUTTON_VARIANT_TOKENS, type ButtonVariant } from "./button.shared";

const VARIANTS = Object.keys(BUTTON_VARIANT_TOKENS).filter(
  (name): name is ButtonVariant => name in BUTTON_VARIANT_TOKENS,
);

describe("the button's shared contract", () => {
  // The React Native renderer paints from the same tokens, so a colour that
  // changes here changes on both platforms.
  test("the web paints every variant from its shared tokens", () => {
    const missing = VARIANTS.flatMap((variant) => {
      const classes = new Set(buttonVariants({ variant }).split(/\s+/u));
      const { surface, label } = BUTTON_VARIANT_TOKENS[variant];
      return `${surface} ${label}`
        .split(/\s+/u)
        .filter((token) => token !== "" && !classes.has(token))
        .map((token) => `${variant}: ${token}`);
    });
    expect(missing).toEqual([]);
  });
});
