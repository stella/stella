import type { ComponentProps } from "react";

import type { ControlSize } from "../lib/control-size";
import { COMPOSER_NATIVE_LINE_HEIGHT } from "./composer-tokens";
import { NativeField } from "./input.native";
import type { TextareaContract } from "./textarea.shared";

/** The web textarea's box at each control size: its border and inset. */
const BOX = {
  sm: "min-h-16 rounded-lg border border-input bg-card px-2.5 py-1.5",
  default: "min-h-20 rounded-lg border border-input bg-card px-3 py-2",
  lg: "min-h-22 rounded-lg border border-input bg-card px-3 py-2.5",
} as const satisfies Record<ControlSize, string>;

/** Unboxed text sits on the container's own line height. */
const UNSTYLED_BOX = {
  sm: "p-0 leading-5",
  default: "p-0",
  lg: "p-0",
} as const satisfies Record<ControlSize, string>;

/**
 * The composer's text: no box, and it gives way to the frame's capped text
 * region (`shrink`), where it scrolls itself, so the caret stays in view as
 * the draft runs past the cap.
 */
const COMPOSER_BOX = "shrink p-0";

/** The composer's one line, which `ComposerFrame` measures its text against. */
const COMPOSER_LINE_STYLE = { lineHeight: COMPOSER_NATIVE_LINE_HEIGHT };

type TextareaProps = Omit<
  ComponentProps<typeof NativeField>,
  "box" | "multiline"
> &
  Pick<TextareaContract, "appearance">;

/**
 * The web's `Textarea` (./textarea.tsx) on a phone: text that wraps and grows,
 * in the web's box, or none for a field inside a container that draws one.
 * With the `composer` appearance it is a `ComposerFrame`'s text.
 */
export const Textarea = ({
  appearance = "default",
  size = "default",
  style,
  unstyled = false,
  ...props
}: TextareaProps) => {
  if (appearance === "composer") {
    return (
      <NativeField
        {...props}
        box={COMPOSER_BOX}
        multiline
        size={size}
        style={[COMPOSER_LINE_STYLE, style]}
      />
    );
  }
  return (
    <NativeField
      {...props}
      box={unstyled ? UNSTYLED_BOX[size] : BOX[size]}
      multiline
      size={size}
      style={style}
    />
  );
};
