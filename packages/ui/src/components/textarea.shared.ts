// The multi-line text field's contract, shared by its two renderers: the
// web's (./textarea.tsx) and React Native's (./textarea.native.tsx). A
// textarea reports its text through its platform's own change event, so the
// contract leaves `onValueChange` to the single-line field.

import type { TextFieldContract } from "./input.shared";

export type TextareaContract = Omit<TextFieldContract, "onValueChange">;
