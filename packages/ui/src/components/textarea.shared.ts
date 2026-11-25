// The multi-line text field's contract, shared by its two renderers: the
// web's (./textarea.tsx) and React Native's (./textarea.native.tsx). A
// textarea reports its text through its platform's own change event, so the
// contract leaves `onValueChange` to the single-line field.

import type { TextFieldContract } from "./input.shared";

export type TextareaContract = Omit<TextFieldContract, "onValueChange"> & {
  /**
   * `composer`: a borderless editor for the `text` slot of a
   * `ComposerFrame`, in the composer's type. It grows with what is typed; the
   * frame caps it and scrolls it.
   */
  appearance?: "default" | "composer";
};
